import { expect, test } from "@playwright/test";
import { makeAccount } from "./helpers";

// Lane B: the /register and /login pages and the signed-in nav, driven through a real browser so
// the forms, the client-side validation (RegisterInput/LoginInput from @healtheat/shared) and the
// he_sid cookie set by Express through the /api/* rewrite are exercised together. Each run
// registers fresh throwaway accounts (e2e/helpers.ts).
const account = makeAccount("ui");

test("register, see the nav, log out and log back in through the pages", async ({
  page,
  context,
  browser,
}) => {
  await page.goto("/register");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Create your account");

  // Client-side validation stops a bad form before it reaches the API.
  await page.getByLabel("Username").fill("No Spaces!");
  await page.getByLabel("Email").fill("not-an-email");
  await page.getByLabel("Password").fill("short");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator("#field-username-error")).toContainText("lowercase letters");
  await expect(page.locator("#field-email-error")).toHaveText("Enter a valid email address.");
  await expect(page.locator("#field-password-error")).toContainText("at least 10 characters");
  await expect(page.getByTestId("nav-username")).toHaveCount(0);

  await page.getByLabel("Username").fill(account.username);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  await expect(page.getByTestId("nav-username")).toHaveText(account.username);
  await expect(page.getByTestId("nav-role")).toHaveText("Member");
  const sid = (await context.cookies()).find((c) => c.name === "he_sid");
  expect(sid?.httpOnly, "session cookie is HttpOnly").toBe(true);

  // The session survives a reload: the nav is driven by GET /api/auth/me.
  await page.reload();
  await expect(page.getByTestId("nav-username")).toHaveText(account.username, { timeout: 30_000 });

  // Registering the same username again is a conflict mapped onto the field.
  // (Checked from a page in a fresh, signed-out context so this tab keeps its session.)
  const other = await browser.newPage();
  await other.goto(new URL("/register", page.url()).toString());
  await other.getByLabel("Username").fill(account.username);
  await other.getByLabel("Email").fill(`dup_${account.email}`);
  await other.getByLabel("Password").fill(account.password);
  await other.getByRole("button", { name: "Create account" }).click();
  await expect(other.locator("#field-username-error")).toHaveText("That username is taken.", {
    timeout: 30_000,
  });
  await other.close();

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("link", { name: "Log in" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("nav-username")).toHaveCount(0);

  await page.getByRole("link", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Username").fill(account.username);
  await page.getByLabel("Password").fill("wrong password");
  await page.getByRole("button", { name: "Log in" }).click();
  // .form-error, not getByRole("alert"): Next.js renders its own route announcer with that role.
  await expect(page.locator(".form-error")).toHaveText("Wrong username or password.", {
    timeout: 30_000,
  });

  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  await expect(page.getByTestId("nav-username")).toHaveText(account.username);
  await expect(page.getByTestId("nav-role")).toHaveText("Member");
});

test("a /me answer sent before login cannot sign the user out again", async ({ page, request }) => {
  // Register through a separate cookie jar, so the browser tab itself starts signed out.
  const acct = makeAccount("race");
  const reg = await request.post("/api/auth/register", { data: acct });
  expect(reg.status(), await reg.text()).toBe(201);

  // Hold every /me answer the page asks for before the login (a slow cold function): each is
  // fetched now, without a session, so it is a 401, and delivered only after the login succeeded.
  let holding = true;
  const held: Promise<void>[] = [];
  let releaseAll!: () => void;
  const gate = new Promise<void>((r) => (releaseAll = r));
  await page.route("**/api/auth/me", async (route) => {
    if (!holding) return route.continue();
    const deliver = (async () => {
      const res = await route.fetch();
      await gate;
      await route.fulfill({ response: res }).catch(() => undefined); // the page may have aborted it
    })();
    held.push(deliver);
    await deliver;
  });

  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
  await expect.poll(() => held.length, { timeout: 30_000 }).toBeGreaterThan(0);
  holding = false;
  await page.getByLabel("Username").fill(acct.username);
  await page.getByLabel("Password").fill(acct.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByTestId("nav-username")).toHaveText(acct.username, { timeout: 30_000 });

  releaseAll();
  await Promise.all(held);
  await page.waitForTimeout(500); // let React apply whatever the stale answers would do
  await expect(page.getByTestId("nav-username")).toHaveText(acct.username);
  await expect(page).toHaveURL(/\/$/);
});

test("a failed logout keeps showing the live session and says so", async ({ page }) => {
  const acct = makeAccount("out");
  // page.request shares the tab's cookies: this signs the tab in.
  const reg = await page.request.post("/api/auth/register", { data: acct });
  expect(reg.status(), await reg.text()).toBe(201);
  await page.goto("/");
  await expect(page.getByTestId("nav-username")).toHaveText(acct.username, { timeout: 30_000 });

  await page.route("**/api/auth/logout", (route) =>
    route.fulfill({ status: 503, json: { error: "database_unavailable" } }),
  );
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByTestId("nav-error")).toContainText("Could not log out");
  await expect(page.getByTestId("nav-username")).toHaveText(acct.username);

  await page.unroute("**/api/auth/logout");
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("link", { name: "Log in" })).toBeVisible({ timeout: 30_000 });
});
