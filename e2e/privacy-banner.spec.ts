import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
// From source, not "@healtheat/shared": the preview's Playwright job does not build dist/.
import { PRIVACY_ACK_COOKIE } from "../packages/shared/src/index";
import { makeAccount } from "./helpers";

// Lane B (T12): the privacy notice on every page until acknowledged, with the he_privacy_ack cookie
// (design doc, "Privacy policy on first visit"; R3-9). Done when: the banner is gone after the
// acknowledgment, and after logging in on a fresh browser context.

const banner = (page: Page) => page.getByTestId("privacy-banner");

async function register(page: Page, account: ReturnType<typeof makeAccount>) {
  // page.request shares the tab's cookies, so an acknowledgment in this tab rides along.
  const res = await page.request.post("/api/auth/register", { data: account });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { user: { privacyAckAt: string | null } };
}

test("the banner shows on every page until acknowledged, then stays away", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).toContainText("photos are analysed by Anthropic and not stored");
  await page.goto("/search");
  await expect(banner(page)).toBeVisible();

  await banner(page).getByRole("link", { name: "Read the privacy policy" }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(banner(page)).toBeVisible();

  await banner(page).getByRole("button", { name: "Got it" }).click();
  await expect(banner(page)).toHaveCount(0);

  const ack = (await context.cookies()).find((c) => c.name === PRIVACY_ACK_COOKIE);
  expect(ack, "acknowledgment cookie").toBeDefined();
  expect(ack?.sameSite).toBe("Lax");
  expect(ack?.httpOnly).toBe(false);
  // One year (allow a day either way for clock skew between the browser and the runner).
  const days = ((ack?.expires ?? 0) - Date.now() / 1000) / 86_400;
  expect(days).toBeGreaterThan(364);
  expect(days).toBeLessThan(366);

  for (const url of ["/", "/about", "/privacy", "/search"]) {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(banner(page), url).toHaveCount(0);
  }
});

test("an acknowledgment follows the account to a fresh browser at login", async ({
  page,
  browser,
  baseURL,
}) => {
  // Acknowledge, then register in the same browser: the API copies the cookie to privacyAckAt.
  const account = makeAccount("pb");
  await page.goto("/");
  await banner(page).getByRole("button", { name: "Got it" }).click();
  const me = await register(page, account);
  expect(me.user.privacyAckAt).not.toBeNull();

  const fresh = await browser.newContext({ baseURL });
  try {
    const other = await fresh.newPage();
    await other.goto("/login");
    await expect(banner(other)).toBeVisible();

    await other.getByLabel("Username").fill(account.username);
    await other.getByLabel("Password").fill(account.password);
    await other.getByRole("button", { name: "Log in" }).click();
    await expect(other.getByTestId("nav-username")).toHaveText(account.username, {
      timeout: 30_000,
    });
    await expect(banner(other)).toHaveCount(0);

    // The login answer set the cookie, so the banner stays away after logout and reload too.
    expect((await fresh.cookies()).map((c) => c.name)).toContain(PRIVACY_ACK_COOKIE);
    await other.getByRole("button", { name: "Log out" }).click();
    await expect(other.getByRole("link", { name: "Log in" })).toBeVisible({ timeout: 30_000 });
    await other.reload();
    await expect(other.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(banner(other)).toHaveCount(0);
  } finally {
    await fresh.close();
  }
});

test("an account that never acknowledged still sees the banner after login", async ({ page }) => {
  const account = makeAccount("pn");
  const me = await register(page, account);
  expect(me.user.privacyAckAt).toBeNull();

  await page.goto("/");
  await expect(page.getByTestId("nav-username")).toHaveText(account.username, {
    timeout: 30_000,
  });
  await expect(banner(page)).toBeVisible();
});

test("the banner fits a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  await expect(banner(page)).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
