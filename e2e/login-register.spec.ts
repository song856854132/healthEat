import { expect, test } from "@playwright/test";
import { holdsFor, makeAccount } from "./helpers";

// Lane B: the /register and /login pages and the signed-in nav, driven through a real browser so
// the forms, the client-side validation (RegisterInput/LoginInput from @healtheat/shared) and the
// he_sid cookie set by Express through the /api/* rewrite are exercised together. Each run
// registers fresh throwaway accounts (e2e/helpers.ts).
const account = makeAccount("ui");

test("register, see the nav, log out and log back in through the pages", async ({
  page,
  context,
  browser,
  baseURL,
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
  const otherContext = await browser.newContext({ baseURL });
  try {
    const other = await otherContext.newPage();
    await other.goto("/register");
    await other.getByLabel("Username").fill(account.username);
    await other.getByLabel("Email").fill(`dup_${account.email}`);
    await other.getByLabel("Password").fill(account.password);
    await other.getByRole("button", { name: "Create account" }).click();
    await expect(other.locator("#field-username-error")).toHaveText("That username is taken.", {
      timeout: 30_000,
    });
  } finally {
    await otherContext.close();
  }

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
  // `settled` resolves once the browser has the whole held answer (or dropped the request because the
  // page aborted it), so the test waits on the real event instead of a fixed sleep.
  let holding = true;
  const held: { deliver: Promise<void>; settled: Promise<unknown> }[] = [];
  let releaseAll!: () => void;
  const gate = new Promise<void>((r) => (releaseAll = r));
  await page.route("**/api/auth/me", async (route) => {
    if (!holding) return route.continue();
    const request = route.request();
    const settled = Promise.race([
      page.waitForEvent("requestfinished", { predicate: (r) => r === request, timeout: 0 }),
      page.waitForEvent("requestfailed", { predicate: (r) => r === request, timeout: 0 }),
    ]);
    const deliver = (async () => {
      const res = await route.fetch();
      await gate;
      await route.fulfill({ response: res }).catch(() => undefined); // the page may have aborted it
    })();
    held.push({ deliver, settled });
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
  await Promise.all(held.map((h) => h.deliver));
  await Promise.all(held.map((h) => h.settled));
  // The stale answers are in the page. Let their promise callbacks run and React commit: a task
  // queued now runs after the microtasks those answers scheduled, and a frame after that commit.
  await page.evaluate(
    () => new Promise((r) => setTimeout(() => requestAnimationFrame(() => setTimeout(r, 0)), 0)),
  );
  const nav = page.getByTestId("nav-username");
  await holdsFor(() => expect(nav).toHaveText(acct.username, { timeout: 100 }));
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

test("a /me error is not shown as signed out, and Retry asks again", async ({ page }) => {
  const acct = makeAccount("me503");
  const reg = await page.request.post("/api/auth/register", { data: acct });
  expect(reg.status(), await reg.text()).toBe(201);

  // A slow Atlas or a cold start: the session is live, the API just cannot say so right now.
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ status: 503, json: { error: "database_unavailable" } }),
  );
  await page.goto("/");
  await expect(page.getByTestId("nav-error")).toHaveText("Could not check your session.", {
    timeout: 30_000,
  });
  await expect(page.getByRole("link", { name: "Log in" })).toHaveCount(0);

  await page.unroute("**/api/auth/me");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("nav-username")).toHaveText(acct.username, { timeout: 30_000 });
});

test("a logout in another tab shows as signed out when this tab is used again", async ({
  page,
  context,
}) => {
  const acct = makeAccount("tabs");
  const reg = await page.request.post("/api/auth/register", { data: acct });
  expect(reg.status(), await reg.text()).toBe(201);
  await page.goto("/");
  await expect(page.getByTestId("nav-username")).toHaveText(acct.username, { timeout: 30_000 });

  const tabB = await context.newPage();
  try {
    await tabB.goto("/");
    await tabB.getByRole("button", { name: "Log out" }).click();
    await expect(tabB.getByRole("link", { name: "Log in" })).toBeVisible({ timeout: 30_000 });
  } finally {
    await tabB.close();
  }

  // Coming back to tab A (headless Chromium does not move focus between pages by itself).
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("link", { name: "Log in" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("nav-username")).toHaveCount(0);
  // And the login form is reachable without a reload.
  await page.getByRole("link", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await holdsFor(() => expect(page).toHaveURL(/\/login$/, { timeout: 100 }), 1_000);
});

test("a 2xx login answer that is not an account shows an error instead of crashing", async ({
  page,
}) => {
  await page.route("**/api/auth/login", (route) =>
    route.fulfill({ status: 200, json: { ok: true } }),
  );
  await page.goto("/login");
  await page.getByLabel("Username").fill("someone");
  await page.getByLabel("Password").fill("some password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.locator(".form-error")).toHaveText(
    "The server sent an unexpected response. Try again.",
    { timeout: 30_000 },
  );
  await expect(page.getByRole("button", { name: "Log in" })).toBeEnabled();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Log in");
});

test.describe("browser time zone", () => {
  // Headless Chromium reports UTC by default; the fallback only shows from another zone.
  test.use({ timezoneId: "America/New_York" });

  test("a time zone the API rejects falls back to UTC instead of blocking registration", async ({
    page,
  }) => {
    const acct = makeAccount("tz");
    const sent: string[] = [];
    let first = true;
    await page.route("**/api/auth/register", async (route) => {
      sent.push((route.request().postDataJSON() as { timezone: string }).timezone);
      if (!first) return route.continue();
      first = false;
      // What the API answers when its ICU does not know a zone the browser reported.
      return route.fulfill({
        status: 400,
        json: {
          error: "validation_error",
          details: [{ path: "timezone", message: "unknown IANA time zone" }],
        },
      });
    });
    await page.goto("/register");
    await page.getByLabel("Username").fill(acct.username);
    await page.getByLabel("Email").fill(acct.email);
    await page.getByLabel("Password").fill(acct.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByTestId("nav-username")).toHaveText(acct.username, { timeout: 30_000 });
    expect(sent).toEqual(["America/New_York", "UTC"]);
  });
});

test("Enter during the redirect after registering sends no second registration", async ({
  page,
}) => {
  const acct = makeAccount("dbl");
  let posts = 0;
  await page.route("**/api/auth/register", (route) => {
    posts += 1;
    return route.continue();
  });
  // Slow down the client navigation to "/" (its RSC request), widening the window between the 201
  // and leaving the page. If "/" was prefetched there is no request, and no window either.
  await page.route(/[?&]_rsc=/, async (route) => {
    await new Promise((r) => setTimeout(r, 1_500));
    await route.continue().catch(() => undefined);
  });
  await page.goto("/register");
  await page.getByLabel("Username").fill(acct.username);
  await page.getByLabel("Email").fill(acct.email);
  await page.getByLabel("Password").fill(acct.password);
  const created = page.waitForResponse(
    (r) => r.url().endsWith("/api/auth/register") && r.status() === 201,
  );
  await page.getByLabel("Password").press("Enter"); // focus stays in the field
  await created;
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("nav-username")).toHaveText(acct.username, { timeout: 30_000 });
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  expect(posts).toBe(1);
});
