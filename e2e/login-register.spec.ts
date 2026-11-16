import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

// Lane B: the /register and /login pages and the signed-in nav, driven through a real browser so
// the forms, the client-side validation (RegisterInput/LoginInput from @healtheat/shared) and the
// he_sid cookie set by Express through the /api/* rewrite are exercised together. Each run
// registers a fresh throwaway account with a random password, as e2e/auth.spec.ts does.
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const account = {
  username: `ui_${suffix}`.slice(0, 24),
  email: `ui_${suffix}@example.com`,
  password: randomUUID(),
};

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
