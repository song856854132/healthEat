import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { makeAccount } from "./helpers";

// Lane B (T12): /profile, the own-profile page (design doc, Pages table; R3-11, R3-14). Sharing
// choices and the phone number are saved through PUT /api/users/me/profiles/member, and Delete
// account runs DELETE /api/users/me. Done when: the deleted account can no longer log in.

async function signUp(page: Page, prefix: string) {
  const account = makeAccount(prefix);
  const res = await page.request.post("/api/auth/register", { data: account });
  expect(res.status(), await res.text()).toBe(201);
  return account;
}

test("a signed-out visitor is sent to log in", async ({ page }) => {
  await page.goto("/profile");
  await expect(page).toHaveURL(/\/login$/, { timeout: 30_000 });
});

test("the nav opens the profile, and sharing choices and the phone are saved", async ({ page }) => {
  const account = await signUp(page, "pf");
  await page.goto("/");
  await page.getByTestId("nav-username").click();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your profile");
  await expect(page.getByTestId("profile-username")).toHaveText(account.username);
  await expect(page.getByRole("main")).toContainText(account.email);

  const publicLogs = page.getByRole("checkbox", { name: /Public logs/ });
  const showPhone = page.getByRole("checkbox", { name: /Show my phone number/ });
  await expect(publicLogs).not.toBeChecked();
  await expect(showPhone).not.toBeChecked();

  // A phone to show is required, and its format is checked before the API is called.
  await showPhone.check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#field-phone-error")).toContainText("Add a phone number");
  await page.getByLabel("Phone number (optional)").fill("call me");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#field-phone-error")).toContainText("digits");

  await page.getByLabel("Phone number (optional)").fill("+1 (617) 555-0100");
  await publicLogs.check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible({
    timeout: 30_000,
  });

  // The public profile now carries the phone; a reload shows the saved choices.
  const pub = await page.request.get(`/api/users/${account.username}`);
  expect(pub.status()).toBe(200);
  expect(((await pub.json()) as { phone: string | null }).phone).toBe("+1 (617) 555-0100");
  await page.reload();
  await expect(page.getByRole("checkbox", { name: /Public logs/ })).toBeChecked({
    timeout: 30_000,
  });
  await expect(page.getByLabel("Phone number (optional)")).toHaveValue("+1 (617) 555-0100");

  // Hiding it again takes the phone off the public profile.
  await page.getByRole("checkbox", { name: /Show my phone number/ }).uncheck();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible({
    timeout: 30_000,
  });
  const hidden = await page.request.get(`/api/users/${account.username}`);
  expect(((await hidden.json()) as { phone: string | null }).phone).toBeNull();
});

test("Delete never removes an account another tab signed in to meanwhile", async ({ page }) => {
  const first = await signUp(page, "pa");
  await page.goto("/profile");
  await expect(page.getByTestId("profile-username")).toHaveText(first.username, {
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Delete account…" }).click();
  await page.getByLabel(/Type your username/).fill(first.username);

  // Another tab logs out and registers a second account: the cookie now names that one, while this
  // page still shows the first and the form is armed. page.request shares the browser's cookies.
  expect((await page.request.post("/api/auth/logout")).ok()).toBe(true);
  const second = await signUp(page, "pb");

  await page.getByRole("button", { name: "Delete my account permanently" }).click();

  // The page checks the session first and shows the account the cookie names; nothing is deleted.
  await expect(page.getByTestId("profile-username")).toHaveText(second.username, {
    timeout: 30_000,
  });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your profile");
  const me = await page.request.get("/api/auth/me");
  expect(me.status()).toBe(200);
  expect(((await me.json()) as { user: { username: string } }).user.username).toBe(second.username);
  expect((await page.request.get(`/api/users/${first.username}`)).status()).toBe(200);
});

test("a refused delete shows why and keeps the account", async ({ page }) => {
  const account = await signUp(page, "pr");
  await page.route("**/api/users/me", (route) =>
    route.request().method() === "DELETE"
      ? route.fulfill({ status: 409, json: { error: "last_admin" } })
      : route.continue(),
  );
  await page.goto("/profile");
  await page.getByRole("button", { name: "Delete account…" }).click({ timeout: 30_000 });
  await page.getByLabel(/Type your username/).fill(account.username);
  const confirm = page.getByRole("button", { name: "Delete my account permanently" });
  await confirm.click();
  await expect(page.locator(".form-error")).toContainText("only Admin", { timeout: 30_000 });
  await expect(confirm).toBeEnabled();
  await expect(page.getByTestId("nav-username")).toHaveText(account.username);
});

test("Delete account asks for the username, deletes, and the account cannot log in", async ({
  page,
}) => {
  const account = await signUp(page, "pd");
  await page.goto("/profile");
  await expect(page.getByTestId("profile-username")).toHaveText(account.username, {
    timeout: 30_000,
  });

  // Cancel leaves everything as it was.
  await page.getByRole("button", { name: "Delete account…" }).click();
  const confirm = page.getByRole("button", { name: "Delete my account permanently" });
  await expect(confirm).toBeDisabled();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);

  await page.getByRole("button", { name: "Delete account…" }).click();
  const typed = page.getByLabel(/Type your username/);
  await typed.fill("someone_else");
  await expect(confirm).toBeDisabled();
  await typed.fill(account.username);
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Account deleted", {
    timeout: 30_000,
  });
  await expect(page.getByRole("link", { name: "Log in" })).toBeVisible();
  await expect(page.getByTestId("nav-username")).toHaveCount(0);

  // The account is gone: its public profile is 404 and the old password no longer logs in.
  expect((await page.request.get(`/api/users/${account.username}`)).status()).toBe(404);
  await page.goto("/login");
  await page.getByLabel("Username").fill(account.username);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.locator(".form-error")).toHaveText("Wrong username or password.", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("nav-username")).toHaveCount(0);
});

test("the profile fits a phone screen", async ({ page }) => {
  await signUp(page, "pw");
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/profile");
  await expect(page.getByTestId("profile-username")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Delete account…" }).click();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
