import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
// From source, not "@healtheat/shared": the preview's Playwright job runs only `npm ci`, so the
// package's dist/ is not built there. Playwright compiles the TypeScript itself.
import { PRIVACY_ACK_COOKIE, SESSION_COOKIE } from "../packages/shared/src/index";

// Lane B (T12, part 1): the /privacy and /about pages. Both are public and static. The privacy page
// must carry every disclosure the design doc lists ("Privacy policy must disclose"), and every cookie
// the site actually sets must be named on it, so the policy cannot drift from the code.

test("both pages are public and reachable from Home", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Privacy policy", exact: true }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Privacy policy");
  await expect(page).toHaveTitle(/Privacy policy/);

  await page.getByRole("link", { name: /^About/ }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("About healthEat");
  await expect(page).toHaveTitle(/About/);

  await page.getByRole("link", { name: "Privacy policy", exact: true }).click();
  await expect(page).toHaveURL(/\/privacy$/);
});

test("the privacy policy makes every disclosure the design doc requires", async ({ page }) => {
  const res = await page.goto("/privacy");
  expect(res?.status()).toBe(200);
  const main = page.getByRole("main");

  // Food searches and details go to USDA; meal photos go to Anthropic and are not stored.
  await expect(main).toContainText("USDA FoodData Central receives your food searches");
  await expect(main).toContainText(/Anthropic receives a meal photo/);
  await expect(main).toContainText("We do not store meal photos.");
  // No other account reads a member's logs; what Curators and Admins see.
  await expect(main).toContainText("cannot read your logs, bands, symptoms");
  await expect(main).toContainText("dictionary data and aggregate match counts");
  await expect(main).toContainText(/Admins.*see account fields only/s);
  // Which profile fields are public.
  await expect(main).toContainText("Your username is public");
  // The signed-out Home lists opted-in members and curators (GET /api/home/public), and a Curator's
  // credentials, bio and specialties are on their public profile (GET /api/users/:username).
  await expect(main).toContainText("visible without signing in");
  await expect(main).toContainText("credentials, bio and specialties are public");
  // What we store includes the daily photo counter (MemberProfile.visionUsage).
  await expect(main).toContainText("how many meal photos you analysed today");
  // Cookies, by name.
  const cookies = page.getByRole("table");
  await expect(cookies.getByRole("rowheader", { name: SESSION_COOKIE })).toBeVisible();
  await expect(cookies.getByRole("rowheader", { name: PRIVACY_ACK_COOKIE })).toBeVisible();
  // How to delete the account and what goes with it.
  await expect(page.getByRole("heading", { name: "Deleting your account" })).toBeVisible();
  await expect(main).toContainText("/api/users/me");
  await expect(main).toContainText("every food log entry, your allergen settings");
});

test("every cookie the site sets is listed on the privacy page", async ({ page, context }) => {
  // Sign in through the proxy (page.request shares the tab's cookies) and use the site a little, so
  // the session cookie and anything else the stack sets is in the jar.
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const reg = await page.request.post("/api/auth/register", {
    data: {
      username: `pv_${suffix}`.slice(0, 24),
      email: `pv_${suffix}@example.com`,
      password: randomUUID(),
      timezone: "UTC",
    },
  });
  expect(reg.status(), await reg.text()).toBe(201);
  await page.goto("/");
  await page.goto("/about");
  await page.goto("/privacy");

  const names = (await context.cookies()).map((c) => c.name);
  expect(names).toContain(SESSION_COOKIE);
  const listed = await page.getByRole("table").getByRole("rowheader").allTextContents();
  for (const name of names) {
    expect(listed, `cookie ${name} is set but not in the policy`).toContain(name);
  }
});

test("the about page credits its data sources", async ({ page }) => {
  const res = await page.goto("/about");
  expect(res?.status()).toBe(200);
  const main = page.getByRole("main");
  for (const [name, href] of [
    ["USDA FoodData Central", "https://fdc.nal.usda.gov/"],
    ["CC0 1.0 Universal", "https://creativecommons.org/publicdomain/zero/1.0/"],
    ["Open Food Facts", "https://world.openfoodfacts.org/"],
    ["Anthropic", "https://www.anthropic.com/"],
  ] as const) {
    await expect(main.getByRole("link", { name, exact: true })).toHaveAttribute("href", href);
  }
  await expect(main).toContainText("FoodData Central data are in the public domain");
  await expect(main).toContainText("Agricultural Research Service");
  await expect(main).toContainText("No Open Food Facts data or taxonomy entries are included");
  await expect(main).toContainText("not medical advice");
});

test("no horizontal scrolling at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  for (const url of ["/privacy", "/about"]) {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, url).toBeLessThanOrEqual(0);
  }
});
