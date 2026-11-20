import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
// From source, not "@healtheat/shared": the preview's Playwright job does not build dist/.
import {
  FoodDetails,
  FoodSearchResponse,
  LogEntryCreated,
  LogEntryView,
  LogListResponse,
  MemberProfileView,
} from "../packages/shared/src/index";
import type { LogEntryView as Entry } from "../packages/shared/src/index";
import { makeAccount } from "./helpers";

// Lane B (T29, proposed in #68): /log/[date], the member's day log. The session is real (each spec
// registers a throwaway account); the log routes are mocked in most specs so the entries, dates and
// failures are deterministic, and every mock is parsed with the shared schema so it cannot drift from
// the API contract. One spec runs against the real log routes.

const TZ = "UTC";
const todayUtc = () => new Date().toISOString().slice(0, 10);
const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function signUp(page: Page, prefix = "dl") {
  const account = makeAccount(prefix);
  const res = await page.request.post("/api/auth/register", { data: account });
  expect(res.status(), await res.text()).toBe(201);
  return account;
}

function entry(over: Partial<Entry> & { id: string; date: string }): Entry {
  return LogEntryView.parse({
    meal: "breakfast",
    fdcId: 2001,
    description: "Mock oatmeal",
    grams: 40,
    source: "search",
    confidence: 1,
    createdAt: "2026-11-10T08:00:00.000Z",
    ...over,
  });
}

/**
 * Answers the member profile (time zone), GET /api/users/me/logs and PUT/DELETE /api/logs/:id from
 * an in-memory list. Records the PUT and DELETE calls.
 */
async function mockDay(page: Page, entries: Entry[]) {
  const store = [...entries];
  const calls: { method: string; id: string; body?: unknown }[] = [];
  await page.route("**/api/users/me/profiles/member", (route) =>
    route.fulfill({
      json: MemberProfileView.parse({
        kind: "member",
        sex: "unspecified",
        birthYear: null,
        heightCm: null,
        weightKg: null,
        activityLevel: "sedentary",
        calorieBand: null,
        timezone: TZ,
        publicLogs: false,
        showPhoneOnProfile: false,
        phone: null,
      }),
    }),
  );
  await page.route("**/api/users/me/logs?*", (route) => {
    const sp = new URL(route.request().url()).searchParams;
    const from = sp.get("from") ?? todayUtc();
    const to = sp.get("to") ?? from;
    return route.fulfill({
      json: LogListResponse.parse({
        from,
        to,
        entries: store.filter((e) => e.date >= from && e.date <= to),
      }),
    });
  });
  await page.route("**/api/logs/*", (route: Route) => {
    const req = route.request();
    const id = new URL(req.url()).pathname.split("/").pop() ?? "";
    const i = store.findIndex((e) => e.id === id);
    if (req.method() === "DELETE") {
      calls.push({ method: "DELETE", id });
      if (i < 0) return route.fulfill({ status: 404, json: { error: "log_not_found" } });
      store.splice(i, 1);
      return route.fulfill({ status: 204, body: "" });
    }
    const body = req.postDataJSON() as Partial<Entry>;
    calls.push({ method: req.method(), id, body });
    if (i < 0) return route.fulfill({ status: 404, json: { error: "log_not_found" } });
    store[i] = LogEntryView.parse({ ...store[i], ...body });
    return route.fulfill({ json: store[i] });
  });
  return calls;
}

test("signed-out visitors are sent to log in", async ({ page }) => {
  await page.goto("/log/2026-11-18");
  await expect(page).toHaveURL(/\/login$/, { timeout: 30_000 });
  await page.goto("/log");
  await expect(page).toHaveURL(/\/login$/, { timeout: 30_000 });
});

test("a date that is not a calendar date is a 404", async ({ page }) => {
  for (const bad of ["2026-02-30", "yesterday", "2026-1-5"]) {
    const res = await page.goto(`/log/${bad}`);
    expect(res?.status(), bad).toBe(404);
  }
});

test("/log opens today's log in the member's time zone, from the real API", async ({ page }) => {
  await signUp(page); // timezone UTC
  await page.goto("/");
  await page.getByTestId("nav-day-log").click();
  await expect(page).toHaveURL(new RegExp(`/log/${todayUtc()}$`), { timeout: 30_000 });
  await expect(page.getByTestId("day-title")).toContainText("Today");
  await expect(page.getByTestId("day-summary")).toHaveText("Nothing logged on this day.", {
    timeout: 30_000,
  });
  // Today has no next day; a future day says it cannot be logged yet.
  await expect(page.getByRole("link", { name: "Next day →" })).toHaveCount(0);
  await page.goto(`/log/${addDays(todayUtc(), 2)}`);
  await expect(page.getByTestId("day-future")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("link", { name: "Go to today" }).click();
  await expect(page).toHaveURL(new RegExp(`/log/${todayUtc()}$`));
});

test("a past day lists its entries by meal, with day navigation", async ({ page }) => {
  await signUp(page);
  const day = addDays(todayUtc(), -3);
  await mockDay(page, [
    entry({ id: "a1", date: day, meal: "dinner", description: "Mock salmon", grams: 150 }),
    entry({ id: "a2", date: day, meal: "breakfast", grams: 40 }),
    entry({
      id: "a3",
      date: day,
      meal: "breakfast",
      description: null,
      fdcId: 3003,
      grams: 120.5,
      source: "photo",
      confidence: 0.8,
    }),
    entry({ id: "other", date: addDays(day, -1), description: "Not this day" }),
  ]);
  await page.goto(`/log/${day}`);

  await expect(page.getByTestId("day-summary")).toHaveText("3 entries · 310.5 g in all", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("day-title")).not.toContainText("Today");
  // Meals in the day's order; empty meals are left out.
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(["Breakfast", "Dinner"]);
  const breakfast = page.getByTestId("meal-breakfast");
  await expect(breakfast.getByTestId("log-entry")).toHaveCount(2);
  await expect(breakfast.getByRole("link", { name: "Mock oatmeal" })).toHaveAttribute(
    "href",
    "/food/2001",
  );
  // A food with no cached name, from a photo: its id, and the confidence (display only).
  const photo = breakfast.getByTestId("log-entry").filter({ hasText: "Food 3003" });
  await expect(photo).toContainText("120.5 g · Photo estimate, 80% confidence");
  await expect(page.getByTestId("meal-dinner")).toContainText("Mock salmon");
  await expect(page.getByText("Not this day")).toHaveCount(0);

  await page.getByRole("link", { name: "Next day →" }).click();
  await expect(page).toHaveURL(new RegExp(`/log/${addDays(day, 1)}$`));
  await expect(page.getByTestId("day-summary")).toHaveText("Nothing logged on this day.", {
    timeout: 30_000,
  });
  await page.getByRole("link", { name: "← Previous day" }).click();
  await expect(page).toHaveURL(new RegExp(`/log/${day}$`));
  await page.getByRole("link", { name: "← Previous day" }).click();
  await expect(page).toHaveURL(new RegExp(`/log/${addDays(day, -1)}$`));
  await expect(page.getByTestId("log-entry")).toHaveText([/Not this day/], { timeout: 30_000 });

  await page.getByLabel("Go to date").fill(day);
  await page.getByRole("button", { name: "Go" }).click();
  await expect(page).toHaveURL(new RegExp(`/log/${day}$`));
  await page.getByRole("link", { name: "Today", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/log/${todayUtc()}$`));
});

test("edit an entry's grams and meal, and delete one after confirming", async ({ page }) => {
  await signUp(page);
  const day = addDays(todayUtc(), -1);
  const calls = await mockDay(page, [
    entry({ id: "e1", date: day, meal: "breakfast", description: "Mock yogurt", grams: 150 }),
    entry({ id: "e2", date: day, meal: "lunch", description: "Mock bread", grams: 60 }),
  ]);
  await page.goto(`/log/${day}`);
  await expect(page.getByTestId("log-entry")).toHaveCount(2, { timeout: 30_000 });

  // A bad amount never reaches the API.
  await page.getByRole("button", { name: "Edit Mock yogurt" }).click();
  await page.getByLabel("Amount (g)").fill("0");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "more than 0" })).toBeVisible();
  await page.getByLabel("Amount (g)").fill("6000");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "at most 5,000 g" })).toBeVisible();
  expect(calls).toHaveLength(0);

  // Cancel restores the entry; Save sends grams and meal and moves it to its new meal.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("meal-breakfast")).toContainText("150 g");
  await page.getByRole("button", { name: "Edit Mock yogurt" }).click();
  await page.getByLabel("Amount (g)").fill("175");
  await page.getByLabel("Meal").selectOption("snack");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("meal-snack")).toContainText("Mock yogurt", { timeout: 30_000 });
  await expect(page.getByTestId("meal-snack").getByTestId("entry-grams")).toHaveText("175 g");
  await expect(page.getByTestId("meal-breakfast")).toHaveCount(0);
  expect(calls).toEqual([{ method: "PUT", id: "e1", body: { grams: 175, meal: "snack" } }]);

  // Delete asks first; Cancel keeps the entry.
  await page.getByRole("button", { name: "Delete Mock bread" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("meal-lunch")).toContainText("Mock bread");
  await page.getByRole("button", { name: "Delete Mock bread" }).click();
  await page.getByRole("button", { name: "Yes, delete" }).click();
  await expect(page.getByTestId("meal-lunch")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("day-summary")).toHaveText("1 entry · 175 g in all");
  expect(calls.at(-1)).toEqual({ method: "DELETE", id: "e2" });

  // The change is on the server: a reload shows the same day.
  await page.reload();
  await expect(page.getByTestId("meal-snack")).toContainText("Mock yogurt", { timeout: 30_000 });
  await expect(page.getByTestId("log-entry")).toHaveCount(1);
});

test("an entry deleted in another tab, and a failed save", async ({ page }) => {
  await signUp(page);
  const day = addDays(todayUtc(), -1);
  await mockDay(page, [
    entry({ id: "gone", date: day, description: "Mock gone" }),
    entry({ id: "kept", date: day, meal: "dinner", description: "Mock kept" }),
  ]);
  await page.goto(`/log/${day}`);
  await expect(page.getByTestId("log-entry")).toHaveCount(2, { timeout: 30_000 });

  // DELETE answers 404 log_not_found: it is gone either way.
  await page.route("**/api/logs/gone", (route) =>
    route.fulfill({ status: 404, json: { error: "log_not_found" } }),
  );
  await page.getByRole("button", { name: "Delete Mock gone" }).click();
  await page.getByRole("button", { name: "Yes, delete" }).click();
  await expect(page.getByText("Mock gone")).toHaveCount(0, { timeout: 30_000 });

  // A server error keeps the form open with the message.
  await page.route("**/api/logs/kept", (route) =>
    route.fulfill({ status: 503, json: { error: "database_unavailable" } }),
  );
  await page.getByRole("button", { name: "Edit Mock kept" }).click();
  await page.getByLabel("Amount (g)").fill("99");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "database is not answering" }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Amount (g)")).toHaveValue("99");
});

test("Add food on a past day carries the date through search to Details", async ({ page }) => {
  await signUp(page);
  const day = addDays(todayUtc(), -2);
  await mockDay(page, []);
  const food = {
    fdcId: 2001,
    description: "Mock banana",
    dataType: "Foundation",
    brandOwner: null,
    ingredientsText: null,
    nutrients: [{ nutrientId: 1008, name: "Energy", unit: "kcal", amountPer100g: 89 }],
  };
  await page.route("**/api/foods/search?*", (route) =>
    route.fulfill({
      json: FoodSearchResponse.parse({
        query: "banana",
        dataType: null,
        page: 1,
        pageSize: 25,
        totalPages: 1,
        totalHits: 1,
        foods: [food],
        cached: false,
        fetchedAt: "2026-11-10T12:00:00.000Z",
      }),
    }),
  );
  await page.route("**/api/foods/2001", (route) =>
    route.fulfill({
      json: FoodDetails.parse({
        ...food,
        servingSizes: [{ label: "1 medium (118 g)", grams: 118 }],
        allergens: [],
        cached: false,
        fetchedAt: "2026-11-10T12:00:00.000Z",
      }),
    }),
  );
  let posted: Record<string, unknown> | undefined;
  await page.route("**/api/users/me/logs", (route) => {
    posted = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({
      status: 201,
      json: LogEntryCreated.parse({
        entry: entry({
          id: "n1",
          date: day,
          meal: "snack",
          description: "Mock banana",
          grams: 118,
        }),
        alerts: [],
      }),
    });
  });

  await page.goto(`/log/${day}`);
  await page.getByTestId("day-add-food").click();
  await expect(page).toHaveURL(new RegExp(`/search\\?date=${day}$`));
  await expect(page.getByTestId("search-log-date")).toContainText("Adding to");

  await page.getByRole("searchbox", { name: "Food" }).fill("banana");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(new RegExp(`/search\\?q=banana&date=${day}$`));
  await expect(page.getByTestId("search-log-date")).toBeVisible();
  await page.getByRole("link", { name: "Mock banana" }).click();
  await expect(page).toHaveURL(new RegExp(`/food/2001\\?date=${day}$`));
  await expect(page.getByTestId("log-date")).toContainText("Logs to");

  await page.locator("#log").getByRole("button").click();
  await expect(page.getByTestId("log-done")).toContainText(`on ${day}`, { timeout: 30_000 });
  expect(posted?.date).toBe(day);
  await page.getByRole("link", { name: "See the day log" }).click();
  await expect(page).toHaveURL(new RegExp(`/log/${day}$`));

  // Without a date (a plain search), Details logs to today and says nothing about a date.
  await page.goto("/food/2001");
  await expect(page.getByTestId("food-title")).toHaveText("Mock banana", { timeout: 30_000 });
  await expect(page.getByTestId("log-date")).toHaveCount(0);
  // A malformed date in the URL is ignored the same way.
  await page.goto("/food/2001?date=2026-13-01");
  await expect(page.getByTestId("food-title")).toHaveText("Mock banana", { timeout: 30_000 });
  await expect(page.getByTestId("log-date")).toHaveCount(0);
});

test("edit and delete against the real log routes", async ({ page }) => {
  await signUp(page);
  // The food is fetched from USDA on first log. The local stack shares api.data.gov's DEMO_KEY, so
  // skip there when USDA is unavailable; a preview (BASE_URL) has its own key and must not skip.
  const created = await page.request.post("/api/users/me/logs", {
    data: { fdcId: 2057648, grams: 30, meal: "breakfast" },
  });
  test.skip(
    created.status() === 503 && !process.env.BASE_URL,
    "USDA unavailable on the local stack (DEMO_KEY quota spent); run against a preview",
  );
  expect(created.status(), await created.text()).toBe(201);
  const { entry: made } = LogEntryCreated.parse(await created.json());

  await page.goto(`/log/${made.date}`);
  const row = page.getByTestId("log-entry");
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await row.getByRole("button", { name: /^Edit / }).click();
  await page.getByLabel("Amount (g)").fill("45");
  await page.getByLabel("Meal").selectOption("lunch");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("meal-lunch").getByTestId("entry-grams")).toHaveText("45 g", {
    timeout: 30_000,
  });
  await page.reload();
  await expect(page.getByTestId("meal-lunch").getByTestId("entry-grams")).toHaveText("45 g", {
    timeout: 30_000,
  });

  await page
    .getByTestId("log-entry")
    .getByRole("button", { name: /^Delete / })
    .click();
  await page.getByRole("button", { name: "Yes, delete" }).click();
  await expect(page.getByTestId("day-summary")).toHaveText("Nothing logged on this day.", {
    timeout: 30_000,
  });
  const after = await page.request.get(`/api/users/me/logs?from=${made.date}&to=${made.date}`);
  expect(LogListResponse.parse(await after.json()).entries).toHaveLength(0);
});

test("no horizontal scrolling at phone width", async ({ page }) => {
  await signUp(page);
  const day = addDays(todayUtc(), -1);
  await mockDay(page, [
    entry({
      id: "w1",
      date: day,
      description: "A very long branded food description that must wrap on a narrow phone screen",
      source: "photo",
      confidence: 0.5,
    }),
  ]);
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(`/log/${day}`);
  await expect(page.getByTestId("log-entry")).toHaveCount(1, { timeout: 30_000 });
  await page.getByRole("button", { name: /^Edit / }).click();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
