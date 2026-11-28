import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
// From source, not "@healtheat/shared": the preview's Playwright job runs only `npm ci`, so the
// package's dist/ is not built there. Playwright compiles the TypeScript itself.
import {
  GapFoodsResponse,
  PublicHomeResponse,
  SummaryResponse,
} from "../packages/shared/src/index";
import { makeAccount } from "./helpers";

// Lane B (T30, with T19's bands): Home at `/`. The first spec of each view runs against the real
// stack; the rest answer the Home routes from mocks so every state is deterministic. Every mock is
// parsed with the shared schema, so it cannot drift from the API contract.

async function signUp(page: Page, prefix = "home") {
  // page.request shares the tab's cookies: this signs the tab in.
  const reg = await page.request.post("/api/auth/register", { data: makeAccount(prefix) });
  expect(reg.status(), await reg.text()).toBe(201);
}

/** Per-row dot states of a band row, e.g. ["searched", "unlogged", ...]. */
async function dotStates(row: Locator): Promise<string[]> {
  return row
    .getByTestId("day-dot")
    .evaluateAll((dots) => dots.map((d) => d.getAttribute("data-state") ?? ""));
}

// ---- anonymous Home ------------------------------------------------------------------------------

test("anonymous Home: the live feed, the example week and a way in, from the real API", async ({
  page,
}) => {
  await page.goto("/");
  const home = page.getByTestId("public-home");
  await expect(home).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Eat well across the week");
  await expect(home).toContainText("healthEat coaches your week of eating");

  // The feed answers, empty or not depending on the database: one sentence when the whole week is
  // empty, else all three blocks.
  await expect(page.getByTestId("feed-week")).toBeVisible({ timeout: 30_000 });
  if ((await page.getByTestId("feed-empty").count()) === 0) {
    for (const id of ["feed-foods", "feed-allergens", "feed-profiles"]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
  }

  // One clearly labelled example band, drawn by the member component, above the feed.
  const example = page.getByTestId("example-week");
  await expect(example.getByRole("heading", { level: 2 })).toHaveText("Example week");
  await expect(example).toContainText("Sample data, not a real member");
  await expect(example.getByTestId("band-header")).toContainText("4 of 7 days logged");
  await expect(example.getByTestId("band-row")).toHaveCount(7);
  expect(
    await home.locator("section").evaluateAll((s) => s.map((x) => x.getAttribute("data-testid"))),
  ).toEqual(["example-week", "public-feed", "start-week"]);

  // No log bar for visitors: Register (the one filled button) and Log in, at the top and the end.
  await expect(page.getByTestId("log-bar")).toHaveCount(0);
  await expect(
    page.getByTestId("start-week").getByRole("link", { name: "Log in" }),
  ).toHaveAttribute("href", "/login");
  await home.getByRole("link", { name: "Register" }).first().click();
  await expect(page).toHaveURL(/\/register$/);
});

const FEED = PublicHomeResponse.parse({
  builtAt: "2026-11-22T12:00:00.000Z",
  week: { from: "2026-11-16", to: "2026-11-22" },
  foods: [
    { fdcId: 1001, description: "Mock oats", count: 3 },
    { fdcId: 1002, description: null, count: 1 },
  ],
  allergens: [{ key: "milk", displayName: "Milk", count: 2 }],
  profiles: [
    {
      username: "mock_curator",
      badges: ["member", "curator"],
      memberSince: "2026-11-01T00:00:00.000Z",
    },
  ],
});

test("anonymous Home lists this week's foods, allergens and profiles, without usernames on foods", async ({
  page,
}) => {
  await page.route("**/api/home/public", (route) => route.fulfill({ json: FEED }));
  await page.goto("/");
  const foods = page.getByTestId("feed-foods");
  await expect(foods.getByRole("link", { name: "Mock oats" })).toHaveAttribute(
    "href",
    "/food/1001",
  );
  await expect(foods).toContainText("3 logs");
  await expect(foods.getByRole("link", { name: "Food 1002" })).toBeVisible();
  await expect(foods).toContainText("1 log");
  await expect(page.getByTestId("feed-allergens")).toContainText("Milk");
  await expect(page.getByTestId("feed-allergens")).toContainText("2 logs");
  await expect(page.getByTestId("feed-allergens").getByRole("heading")).toHaveText(
    "Allergens detected most",
  );
  await expect(foods.getByRole("heading")).toHaveText("Foods logged most");
  const profiles = page.getByTestId("feed-profiles");
  await expect(profiles).toContainText("mock_curator");
  await expect(profiles).toContainText("Curator");
  await expect(profiles).toContainText("joined Nov 1");
  await expect(page.getByTestId("feed-week")).toContainText("Nov 16 to Nov 22");
  await expect(page.getByTestId("feed-empty")).toHaveCount(0);
});

test("anonymous Home says when the feed is empty, and offers Try again when it fails", async ({
  page,
}) => {
  let fail = true;
  await page.route("**/api/home/public", (route) =>
    fail
      ? route.fulfill({ status: 503, json: { error: "database_unavailable" } })
      : route.fulfill({ json: { ...FEED, foods: [], allergens: [], profiles: [] } }),
  );
  await page.goto("/");
  const error = page.getByTestId("feed-error");
  await expect(error).toContainText("The database is not answering", { timeout: 30_000 });
  fail = false;
  await error.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("feed-empty")).toHaveText(
    "Nothing has been logged on healthEat this week yet.",
  );
  await expect(page.getByTestId("feed-foods")).toHaveCount(0);
});

test("anonymous Home says which feed block is empty when only some are", async ({ page }) => {
  await page.route("**/api/home/public", (route) =>
    route.fulfill({ json: { ...FEED, allergens: [], profiles: [] } }),
  );
  await page.goto("/");
  await expect(page.getByTestId("feed-foods")).toContainText("Mock oats", { timeout: 30_000 });
  await expect(page.getByTestId("feed-allergens")).toContainText("No allergens detected");
  await expect(page.getByTestId("feed-profiles")).toContainText("No public profiles yet.");
  await expect(page.getByTestId("feed-empty")).toHaveCount(0);
});

// ---- Member Home ---------------------------------------------------------------------------------

test("a new member's Home, from the real API: empty bands, no meter yet, and a log bar", async ({
  page,
}) => {
  await signUp(page, "hnew");
  await page.goto("/");
  await expect(page.getByTestId("member-home")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("public-home")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your week");

  await expect(page.getByTestId("band-header")).toContainText("0 of 7 days logged", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("bands-empty")).toHaveText(
    "Nothing logged in the last 7 days. Each day you log fills in a column here.",
  );
  // Registration asks only for the time zone, so targets use the adult reference and the meter waits.
  await expect(page.getByTestId("target-basis")).toContainText("adult reference");
  await expect(page.getByTestId("calorie-incomplete")).toBeVisible();
  await expect(page.getByTestId("exposure-empty")).toHaveText(
    "You are not tracking any sensitivities. Choose them on your profile.",
  );
  await expect(page.getByTestId("alert-strip")).toHaveCount(0);
  await expect(page.getByTestId("close-the-gap")).toHaveCount(0);

  const bar = page.getByRole("region", { name: "Log a meal" });
  await expect(bar).toHaveAttribute("data-testid", "log-bar");
  await expect(bar.getByRole("link", { name: "Log by photo" })).toHaveAttribute(
    "href",
    "/log?photo=1",
  );
  await bar.getByRole("link", { name: "Search food" }).click();
  await expect(page).toHaveURL(/\/search$/);
});

// T19's fixture: 4 of 7 days logged, one of them mostly photo-estimated (confidence below 0.5).
const DAYS = [
  { date: "2026-11-16", logged: true, confidence: 1 },
  { date: "2026-11-17", logged: false, confidence: null },
  { date: "2026-11-18", logged: true, confidence: 0.25 },
  { date: "2026-11-19", logged: true, confidence: 0.8 },
  { date: "2026-11-20", logged: false, confidence: null },
  { date: "2026-11-21", logged: true, confidence: 1 },
  { date: "2026-11-22", logged: false, confidence: null },
];
const DOTS = ["searched", "unlogged", "photo", "searched", "unlogged", "searched", "unlogged"];

const b = (
  key: string,
  name: string,
  coverage: number | null,
  status: string,
  dataCoverage = 1,
  target = 10,
) => ({
  key,
  name,
  unit: "mg",
  target,
  upper: null,
  intakePerDay: coverage === null ? null : coverage * target,
  coverage,
  dataCoverage,
  status,
});

const SUMMARY = SummaryResponse.parse({
  weekEnding: "2026-11-22",
  today: "2026-11-22",
  days: DAYS,
  loggedDays: 4,
  targetBasis: "personal",
  driSetKey: "female-31-50",
  // API display order; Home puts the most urgent first.
  bands: [
    b("protein", "Protein", 1.1, "ok"),
    b("fiber", "Fiber", 0.62, "low"),
    b("vitaminD", "Vitamin D", null, "insufficient", 0.3),
    b("vitaminE", "Vitamin E", 0.41, "low", 1, 15),
    b("iron", "Iron", 1.04, "ok"),
    b("sodium", "Sodium", 1.63, "high"),
    b("calcium", "Calcium", 0.9, "ok"),
    b("zinc", "Zinc", 0.8, "ok"),
  ],
  calorieMeter: { kcal: 2480, low: 1900, high: 2300, status: "over", basis: "computed" },
  calorieMeterReason: null,
  exposure: [
    {
      key: "gluten",
      displayName: "Gluten",
      tier: "sensitivity",
      hits: 9,
      weight: 4.2,
      weeklyThreshold: 6,
      overThreshold: true,
      estimate: false,
    },
    {
      key: "histamine",
      displayName: "Histamine-rich foods",
      tier: "sensitivity",
      hits: 2,
      weight: 0.6,
      weeklyThreshold: null,
      overThreshold: false,
      estimate: true,
    },
    {
      key: "lactose",
      displayName: "Lactose",
      tier: "sensitivity",
      hits: 3,
      weight: 1.1,
      weeklyThreshold: 4,
      overThreshold: false,
      estimate: false,
    },
  ],
  alerts: [
    {
      key: "soy",
      displayName: "Soy",
      fdcId: 2001,
      description: "Mock dark chocolate",
      matchKind: "ingredient",
    },
  ],
});

const gap = (id: number, key: string, name: string, foods: [number, string, number, number][]) =>
  GapFoodsResponse.parse({
    nutrient: { id, key, name, unit: "mg" },
    foods: foods.map(([fdcId, description, portionGrams, amountPerPortion]) => ({
      fdcId,
      description,
      source: "seed",
      amountPer100g: (amountPerPortion * 100) / portionGrams,
      kcalPer100g: 500,
      portionGrams,
      amountPerPortion,
    })),
  });

async function mockMemberWeek(page: Page) {
  await page.route("**/api/users/me/summary*", (route) => route.fulfill({ json: SUMMARY }));
  // USDA ids from TRACKED_NUTRIENTS: vitamin E 1109, fiber 1079.
  await page.route("**/api/users/me/gaps/1109/foods", (route) =>
    route.fulfill({
      json: gap(1109, "vitaminE", "Vitamin E", [
        [3001, "Mock sunflower seeds", 28, 7.4],
        [3002, "Mock almonds", 28, 7.3],
      ]),
    }),
  );
  await page.route("**/api/users/me/gaps/1079/foods", (route) =>
    route.fulfill({ json: gap(1079, "fiber", "Fiber", [[3003, "Mock lentils", 100, 7.9]]) }),
  );
}

test("T19 bands on a 4-of-7 week: header, order, per-day dots and the band encoding", async ({
  page,
}) => {
  await signUp(page, "hband");
  await mockMemberWeek(page);
  await page.goto("/");

  const bands = page.getByTestId("bands-section");
  await expect(bands.getByTestId("band-header")).toContainText(
    "4 of 7 days logged · 1 mostly photo-estimated",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("target-basis")).toContainText("your sex and age band");

  // Most urgent first (low by coverage, then high, then ok); six rows until "Show all".
  const rows = bands.getByTestId("band-row");
  await expect(rows).toHaveCount(6);
  expect(await rows.evaluateAll((r) => r.map((x) => x.getAttribute("data-key")))).toEqual([
    "vitaminE",
    "fiber",
    "sodium",
    "zinc",
    "calcium",
    "iron",
  ]);
  await bands.getByRole("button", { name: "Show all 8 nutrients" }).click();
  await expect(rows).toHaveCount(8);
  await expect(bands.getByRole("button", { name: "Show fewer" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );

  // Seven dots under every band: filled searched, hollow photo-estimated, absent unlogged.
  for (const row of await rows.all()) expect(await dotStates(row)).toEqual(DOTS);

  const row = (key: string) => bands.locator(`[data-testid="band-row"][data-key="${key}"]`);
  await expect(row("vitaminE").getByTestId("band-value")).toHaveText("41%");
  await expect(row("vitaminE").getByTestId("band-word")).toHaveText("Low this week");
  await expect(row("sodium").getByTestId("band-value")).toHaveText("163%");
  await expect(row("sodium").getByTestId("band-word")).toHaveText("High this week");
  await expect(row("iron").getByTestId("band-value")).toHaveText("104%");
  await expect(row("iron").getByTestId("band-word")).toHaveText("OK this week");
  await expect(row("vitaminD").getByTestId("band-word")).toHaveCount(0);
  await expect(row("vitaminD")).toContainText("Not enough data: 30% of logged grams report it");

  // The visual encoding itself, read from the rendered styles (Working plan amendments, C5, drawn as
  // the v2 UI design's cells): low = hatch with a dashed outline, ok = plain with a solid outline,
  // high = cross-hatch with a 2px outline.
  const fill = async (key: string) =>
    row(key)
      .locator("span[style*='width']")
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          image: s.backgroundImage,
          border: s.borderTopWidth,
          style: s.borderTopStyle,
        };
      });
  const low = await fill("vitaminE");
  expect(low.image).toContain("repeating-linear-gradient");
  expect(low).toMatchObject({ border: "1px", style: "dashed" });
  const ok = await fill("iron");
  expect(ok).toEqual({ image: "none", border: "1px", style: "solid" });
  const high = await fill("sodium");
  expect(high.image.match(/repeating-linear-gradient/g)).toHaveLength(2);
  expect(high).toMatchObject({ border: "2px", style: "solid" });
  // Dots: a filled disc, a hollow ring, and nothing for an unlogged day.
  const dot = (i: number) =>
    row("iron")
      .getByTestId("day-dot")
      .nth(i)
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, border: s.borderTopWidth };
      });
  const searched = await dot(0);
  const photo = await dot(2);
  expect(searched.border).toBe("0px");
  expect(searched.bg).not.toBe("rgba(0, 0, 0, 0)");
  expect(photo.border).toBe("2px");
  expect(photo.bg).not.toBe(searched.bg);
  expect(await dot(1)).toEqual({ bg: "rgba(0, 0, 0, 0)", border: "0px" });
});

test("Member Home: the alert strip, today's calorie meter and the exposure meter", async ({
  page,
}) => {
  await signUp(page, "hweek");
  await mockMemberWeek(page);
  await page.goto("/");

  const alert = page.getByTestId("alert-strip");
  await expect(alert).toContainText("Soy detected today in Mock dark chocolate", {
    timeout: 30_000,
  });
  await expect(alert.locator("p").first()).toHaveText("Allergy alert");
  await expect(alert.getByRole("link", { name: "Open today’s log" })).toHaveAttribute(
    "href",
    "/log",
  );
  // The strip comes first, above the page's h1.
  expect(
    await page
      .getByTestId("member-home")
      .evaluate((el) => [...el.children].slice(0, 2).map((c) => c.tagName)),
  ).toEqual(["DIV", "H1"]);
  await expect(alert).toContainText("Soy is on your avoid list.");
  await expect(alert.getByRole("link", { name: "Mock dark chocolate" })).toHaveAttribute(
    "href",
    "/food/2001",
  );

  const meter = page.getByTestId("calorie-meter");
  await expect(meter.getByTestId("calorie-status")).toHaveText(
    "About 2,480 kcal so far. Your band is 1,900 to 2,300 kcal, estimated from your profile.",
  );
  await expect(
    meter.getByRole("img", {
      name: "About 2,480 kcal so far, over your band of 1,900 to 2,300 kcal",
    }),
  ).toBeVisible();
  await expect(meter).toContainText("your band");

  const exposure = page.getByTestId("exposure-row");
  await expect(exposure).toHaveCount(3);
  await expect(exposure.nth(0)).toContainText("Gluten");
  await expect(exposure.nth(0)).toContainText(
    "9 logged entries this week; your threshold is 6 a week, and this week is above it.",
  );
  await expect(exposure.nth(0)).toHaveAttribute("data-over", "true");
  await expect(exposure.nth(0)).toHaveAttribute("data-zone", "heavy");
  await expect(exposure.nth(0).getByRole("img", { name: "Gluten this week: heavy" })).toBeVisible();
  await expect(exposure.nth(1)).toContainText("food-category estimate");
  await expect(exposure.nth(1)).toContainText("2 logged entries this week. No threshold set");
  await expect(exposure.nth(1).getByRole("img")).toHaveCount(0);
  // Light up to half the threshold, Moderate up to it, Heavy past it.
  await expect(exposure.nth(2)).toHaveAttribute("data-zone", "moderate");
  await expect(exposure.nth(2).locator("strong")).toHaveText("Moderate");
});

test("close the gap suggests foods for the lowest band, and for any other low band on request", async ({
  page,
}) => {
  await signUp(page, "hgap");
  await mockMemberWeek(page);
  await page.goto("/");

  const gapSection = page.getByTestId("close-the-gap");
  await expect(gapSection.getByRole("heading", { level: 2 })).toHaveText("Close the gap", {
    timeout: 30_000,
  });
  await expect(gapSection.getByTestId("gap-lead")).toHaveText(
    "Vitamin E was low this week, at 41% of your target. These foods add the most vitamin E per calorie and contain nothing you avoid.",
  );
  const foods = gapSection.getByTestId("gap-foods");
  await expect(foods.getByRole("link", { name: "Mock sunflower seeds" })).toHaveAttribute(
    "href",
    "/food/3001",
  );
  await expect(foods).toContainText("28 g, about 7.4 mg vitamin E");
  await expect(gapSection.getByRole("button", { name: "Vitamin E" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await gapSection.getByRole("button", { name: "Fiber" }).click();
  await expect(gapSection.getByTestId("gap-lead")).toContainText(
    "Fiber was low this week, at 62% of your target.",
  );
  await expect(foods.getByRole("link", { name: "Mock lentils" })).toBeVisible();
  await expect(foods.getByRole("link", { name: "Mock sunflower seeds" })).toHaveCount(0);
});

test("Member Home offers Try again when the summary fails", async ({ page }) => {
  await signUp(page, "herr");
  let fail = true;
  await page.route("**/api/users/me/summary*", (route) =>
    fail
      ? route.fulfill({ status: 503, json: { error: "database_unavailable" } })
      : route.fulfill({ json: SUMMARY }),
  );
  await page.goto("/");
  const error = page.getByTestId("summary-error");
  await expect(error).toContainText("The database is not answering", { timeout: 30_000 });
  // The log bar stays usable while the week cannot load.
  await expect(page.getByTestId("log-bar")).toBeVisible();
  fail = false;
  await error.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("band-header")).toContainText("4 of 7 days logged");
});

test("Member Home refreshes the week when the tab comes back, and keeps it if that fails", async ({
  page,
}) => {
  await signUp(page, "hback");
  // First visit: no alert yet. Meanwhile (another tab) the member logs a food they avoid.
  let answer: "quiet" | "alert" | "fail" = "quiet";
  await page.route("**/api/users/me/summary*", (route) =>
    answer === "fail"
      ? route.fulfill({ status: 503, json: { error: "database_unavailable" } })
      : route.fulfill({ json: answer === "quiet" ? { ...SUMMARY, alerts: [] } : SUMMARY }),
  );
  const returnToTab = () =>
    page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.goto("/");
  await expect(page.getByTestId("band-header")).toContainText("4 of 7 days logged", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("alert-strip")).toHaveCount(0);

  answer = "alert";
  await returnToTab();
  await expect(page.getByTestId("alert-strip")).toContainText("Soy detected today", {
    timeout: 30_000,
  });

  // A refresh that fails leaves the week on screen instead of an error.
  answer = "fail";
  const failed = page.waitForResponse((r) => r.url().includes("/api/users/me/summary"));
  await returnToTab();
  await failed;
  await expect(page.getByTestId("alert-strip")).toBeVisible();
  await expect(page.getByTestId("summary-error")).toHaveCount(0);
});
