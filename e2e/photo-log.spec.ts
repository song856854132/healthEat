import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
// From source, not "@healtheat/shared": the preview's Playwright job does not build dist/.
import {
  FoodSearchResponse,
  LogEntryCreated,
  LogEntryView,
  LogListResponse,
  VISION_LIMIT_MESSAGE,
  VisionMealResponse,
} from "../packages/shared/src/index";
import type { VisionItem } from "../packages/shared/src/index";
import { makeAccount } from "./helpers";

// T13 web half: Log by photo on /log/[date] (design doc, Photo pipeline). The member session, the
// profile and the day's log are the real stack; POST /api/vision/meal is ALWAYS mocked (no test may
// reach Anthropic: the beforeEach route below answers anything a test does not), and USDA search and
// the log POST are mocked so the matches and the written entries are deterministic.

const today = () => new Date().toISOString().slice(0, 10); // accounts register in UTC (helpers.ts)

test.beforeEach(async ({ page }) => {
  // The guard: a vision call no test answered fails here instead of reaching the real API.
  await page.route("**/api/vision/meal", (route) =>
    route.fulfill({ status: 599, json: { error: "unmocked_vision_call" } }),
  );
});

async function signUp(page: Page) {
  const res = await page.request.post("/api/auth/register", { data: makeAccount("ph") });
  expect(res.status(), await res.text()).toBe(201);
}

type Answer = { status: number; json: unknown } | "hang" | "fail";

/** Answers the vision calls in turn and records their bodies. */
async function mockVision(page: Page, answers: Answer[]) {
  const bodies: { image: string; mediaType: string }[] = [];
  await page.route("**/api/vision/meal", async (route) => {
    bodies.push(route.request().postDataJSON() as { image: string; mediaType: string });
    const answer = answers.shift() ?? { status: 500, json: { error: "unexpected" } };
    if (answer === "hang") return; // never answered: the page must cope (Cancel)
    if (answer === "fail") return route.abort("internetdisconnected"); // the connection dropped
    return route.fulfill({ status: answer.status, json: answer.json });
  });
  return bodies;
}

function analysed(items: VisionItem[], remainingToday = 17): Answer {
  return { status: 200, json: VisionMealResponse.parse({ items, remainingToday }) };
}

function food(fdcId: number, description: string) {
  return {
    fdcId,
    description,
    dataType: "Foundation",
    brandOwner: null,
    ingredientsText: null,
    nutrients: [{ nutrientId: 1008, name: "Energy", unit: "kcal", amountPer100g: 100 }],
  };
}

/** An avoid-mode allergen a logged food matched, as POST /api/users/me/logs names it. */
function avoided(key: string, displayName: string) {
  return { key, displayName, tier: "allergy", matchKind: "ingredient", matchedSynonym: key };
}

const FOODS: Record<string, ReturnType<typeof food>[]> = {
  banana: [food(2001, "Mock banana"), food(2002, "Mock banana chips")],
  "oat milk": [food(3001, "Mock oat milk")],
  // A real USDA food: only the test against the real log route uses it (the API fetches it on log).
  "rolled oats": [food(2057648, "Mock rolled oats")],
  "oatmilk barista": [food(3002, "Mock oatmilk barista")],
  apple: [food(4002, "Mock apple")],
  pear: [food(4001, "Mock pear")],
  salt: [food(5001, "Mock salt")],
  napkin: [],
};

/** The USDA search answer for a query's words; anything unknown finds nothing. */
function searchAnswer(q: string) {
  const foods = FOODS[q] ?? [];
  return FoodSearchResponse.parse({
    query: q,
    dataType: null,
    page: 1,
    pageSize: 25,
    totalPages: foods.length ? 1 : 0,
    totalHits: foods.length,
    foods,
    cached: true,
    fetchedAt: "2026-11-26T12:00:00.000Z",
  });
}

/** USDA search by the query's words; anything unknown finds nothing. */
async function mockSearch(page: Page) {
  await page.route("**/api/foods/search?*", (route) =>
    route.fulfill({
      json: searchAnswer(new URL(route.request().url()).searchParams.get("q") ?? ""),
    }),
  );
}

/**
 * Answers POST /api/users/me/logs in turn (201 by default), recording bodies; GET goes to the API.
 * `alerts` are the avoided allergens each food's answer names, by fdcId.
 */
async function mockLogPosts(
  page: Page,
  statuses: number[] = [],
  alerts: Record<number, ReturnType<typeof avoided>[]> = {},
) {
  const posts: Record<string, unknown>[] = [];
  await page.route("**/api/users/me/logs", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    posts.push(body);
    const status = statuses.shift() ?? 201;
    if (status !== 201) return route.fulfill({ status, json: { error: "database_unavailable" } });
    const all = Object.values(FOODS).flat();
    return route.fulfill({
      status: 201,
      json: LogEntryCreated.parse({
        entry: {
          id: `p${posts.length}`,
          date: body.date,
          meal: body.meal,
          fdcId: body.fdcId,
          description: all.find((f) => f.fdcId === body.fdcId)?.description ?? null,
          grams: body.grams,
          source: "photo",
          confidence: body.confidence,
          createdAt: "2026-11-26T12:00:00.000Z",
        },
        alerts: alerts[body.fdcId as number] ?? [],
      }),
    });
  });
  return posts;
}

/** A PNG made in the browser, `width` x `height`, as a file for the photo input. */
async function photoFile(page: Page, width = 2000, height = 1500) {
  const b64 = await page.evaluate(
    ([w, h]) => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#c84";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#fff";
      ctx.fillRect(w / 4, h / 4, w / 2, h / 2);
      return canvas.toDataURL("image/png").split(",")[1];
    },
    [width, height],
  );
  return { name: "meal.png", mimeType: "image/png", buffer: Buffer.from(b64, "base64") };
}

async function openPanel(page: Page) {
  await page.goto(`/log/${today()}`);
  await page.getByTestId("day-add-photo").click({ timeout: 30_000 });
  await expect(page.getByTestId("photo-panel")).toBeVisible();
}

test("a photo's items are confirmed against USDA, edited, and logged as photo estimates", async ({
  page,
}) => {
  await signUp(page);
  const visionBodies = await mockVision(page, [
    analysed([
      { query: "banana", grams: 120, confidence: 0.9 },
      { query: "oat milk", grams: 200, confidence: 0.4 },
      { query: "napkin", grams: 5, confidence: 0.2 },
    ]),
  ]);
  await mockSearch(page);
  const posts = await mockLogPosts(page, [], {
    2002: [avoided("milk", "Milk"), avoided("peanut", "Peanut")],
    3002: [avoided("milk", "Milk"), avoided("soy", "Soy")],
  });
  await openPanel(page);
  await page.getByTestId("photo-input").setInputFiles(await photoFile(page));

  const review = page.getByTestId("photo-review");
  await expect(review).toBeVisible({ timeout: 30_000 });
  await expect(review).toContainText("17 of 20 photos left today");
  const items = review.getByTestId("photo-item");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText("likely");
  await expect(items.nth(1)).toContainText("not sure");
  await expect(review).not.toContainText("%"); // sureness in words, never a percentage
  await expect(items.nth(0).getByRole("radio", { name: "Mock banana", exact: true })).toBeChecked();
  await expect(items.nth(2)).toContainText("No USDA food matches");

  // The photo went out made small: a 1024 x 768 JPEG, base64 without a data: prefix.
  expect(visionBodies).toHaveLength(1);
  expect(visionBodies[0].mediaType).toBe("image/jpeg");
  expect(visionBodies[0].image.startsWith("data:")).toBe(false);
  const size = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/jpeg;base64,${b64}`;
    await img.decode();
    return [img.naturalWidth, img.naturalHeight];
  }, visionBodies[0].image);
  expect(size).toEqual([1024, 768]);

  // Value: protects=an included item with no USDA food stops the whole photo batch with a message;
  //   fails_when=the no-food check is dropped and the batch logs the rest, skipping that item
  //   silently;
  //   why_new=only the grams check was exercised (the napkin was removed first); seam=none;
  //   no_claim=USDA search and the log POST are mocked; the real log route is not reached
  await expect(items.nth(1).getByRole("radio", { name: "Mock oat milk" })).toBeChecked();
  await page.getByTestId("photo-log").click();
  await expect(items.nth(2)).toContainText("Choose the food it is, or search again.");
  expect(posts).toHaveLength(0);

  // Remove the napkin; an impossible amount stops the whole batch before anything is sent.
  await items.nth(2).getByRole("button", { name: "Remove" }).click();
  await items.nth(0).getByLabel("Grams").fill("6000");
  await page.getByTestId("photo-log").click();
  await expect(items.nth(0)).toContainText("At most 5,000 g.");
  expect(posts).toHaveLength(0);
  await items.nth(0).getByLabel("Grams").fill("150");

  // Value: protects=the match the member picks is the food logged, not the first suggestion;
  //   fails_when=picking another match leaves the item on its first match, so the wrong food is
  //   logged;
  //   why_new=the test only checked that the first match was preselected; seam=none;
  //   no_claim=USDA search and the log POST are mocked
  await items.nth(0).getByRole("radio", { name: "Mock banana chips" }).check();

  // A better search for the second item, and the meal for the batch.
  await items.nth(1).getByLabel("Search for").fill("oatmilk barista");
  await items.nth(1).getByRole("button", { name: "Search again" }).click();
  await expect(items.nth(1).getByRole("radio", { name: "Mock oatmilk barista" })).toBeChecked();
  await page.getByLabel("Meal").selectOption("dinner");
  await expect(page.getByTestId("photo-log")).toHaveText("Log 2 items");
  await page.getByTestId("photo-log").click();

  await expect(page.getByTestId("photo-done")).toContainText("Logged 2 items", { timeout: 30_000 });
  expect(posts).toHaveLength(2);
  expect(posts.map((p) => [p.fdcId, p.grams, p.meal, p.date, p.source, p.confidence])).toEqual([
    [2002, 150, "dinner", today(), "photo", 0.9],
    [3002, 200, "dinner", today(), "photo", 0.4],
  ]);
  expect(posts[0].requestId).toEqual(expect.any(String));
  expect(posts[0].requestId).not.toBe(posts[1].requestId);
  expect(posts[0].photoBatchId).toEqual(expect.any(String));
  expect(posts[1].photoBatchId).toBe(posts[0].photoBatchId);
  // Value: protects=a photo batch names every avoided allergen its items matched, each once;
  //   fails_when=the photo flow drops the alerts, keeps only one item's, or repeats a shared one;
  //   why_new=the log POST mock always answered no alerts; seam=none;
  //   no_claim=allergen matching itself (mocked log answers; the API tests cover matching)
  await expect(page.getByTestId("photo-alerts")).toHaveText(
    "Contains Milk, Peanut, Soy, which you avoid.",
  );
  // The new entries are on the day, marked as photo estimates.
  await expect(page.getByTestId("meal-dinner")).toContainText("Mock banana chips");
  await expect(page.getByTestId("meal-dinner")).toContainText("Photo estimate");
});

test("each failure says what to do: the daily limit, a refused photo, a timeout that retries, an unavailable service, a dropped connection", async ({
  page,
}) => {
  await signUp(page);
  const bodies = await mockVision(page, [
    { status: 429, json: { error: "vision_limit", details: VISION_LIMIT_MESSAGE } },
    {
      status: 422,
      json: {
        error: "vision_refused",
        details: "This photo could not be analysed; log the meal by search",
      },
    },
    {
      status: 504,
      json: { error: "vision_timeout", details: "The photo took too long to analyse; try again" },
    },
    analysed([{ query: "banana", grams: 100, confidence: 0.8 }], 15),
    {
      status: 503,
      json: { error: "vision_unavailable", details: "Photo logging is not available right now" },
    },
    "fail",
    analysed([{ query: "banana", grams: 100, confidence: 0.8 }], 14),
  ]);
  await mockSearch(page);
  await openPanel(page);
  const error = page.getByTestId("photo-error");
  const file = await photoFile(page, 400, 300);

  await page.getByTestId("photo-input").setInputFiles(file);
  await expect(error).toContainText(VISION_LIMIT_MESSAGE, { timeout: 30_000 });
  await expect(error.getByRole("link", { name: "Log by search" })).toHaveAttribute(
    "href",
    `/search?date=${today()}`,
  );
  await expect(page.getByTestId("photo-retry")).toHaveCount(0);
  // Value: protects=after today's limit, or with photo logging unavailable, no other photo is
  //   offered, since it would be refused the same way; fails_when=the picker ignores the problem's
  //   `another` flag and offers "Choose another photo" anyway; why_new=the test went on through the
  //   picker; seam=none; no_claim=the vision API is mocked
  await expect(page.getByTestId("photo-input")).toHaveCount(0);
  await page.getByTestId("photo-close").click();
  await page.getByTestId("day-add-photo").click();

  await page.getByTestId("photo-input").setInputFiles(file);
  await expect(error).toContainText("Log the meal by search instead", { timeout: 30_000 });
  await expect(page.getByTestId("photo-retry")).toHaveCount(0);

  await page.getByTestId("photo-input").setInputFiles(file);
  await expect(error).toContainText("took too long", { timeout: 30_000 });
  await page.getByTestId("photo-retry").click();
  await expect(page.getByTestId("photo-review")).toContainText("15 of 20 photos left today", {
    timeout: 30_000,
  });
  expect(bodies[3].image).toBe(bodies[2].image); // Try again resent the same photo

  await page.getByRole("button", { name: "Start over" }).click();
  await page.getByTestId("photo-input").setInputFiles(file);
  await expect(error).toContainText("Photo logging is not available right now.", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("photo-retry")).toHaveCount(0);
  await expect(page.getByTestId("photo-input")).toHaveCount(0);
  await page.getByTestId("photo-close").click();
  await page.getByTestId("day-add-photo").click();

  // Value: protects=a connection that drops while the photo is sent says so, and Try again resends
  //   it;
  //   fails_when=a network failure leaves the panel waiting or silent, or offers no Try again;
  //   why_new=only HTTP error answers were tried; seam=none;
  //   no_claim=the vision API is mocked (route.abort stands in for the dropped connection)
  await page.getByTestId("photo-input").setInputFiles(file);
  await expect(error).toContainText("Could not reach the server", { timeout: 30_000 });
  await page.getByTestId("photo-retry").click();
  await expect(page.getByTestId("photo-review")).toContainText("14 of 20 photos left today", {
    timeout: 30_000,
  });
  expect(bodies[6].image).toBe(bodies[5].image); // Try again resent the same photo
});

test("Cancel while the photo is analysed, a photo with nothing recognised, and a file that is not a photo", async ({
  page,
}) => {
  await signUp(page);
  const bodies = await mockVision(page, ["hang", analysed([], 16)]);
  await openPanel(page);
  const file = await photoFile(page, 400, 300);

  await page.getByTestId("photo-input").setInputFiles(file);
  await expect(page.getByTestId("photo-analysing")).toContainText("up to a minute", {
    timeout: 30_000,
  });
  // Cancel once the photo is with the server (a Cancel during the session check sends nothing, so
  // the hanging answer would be left for the next photo; that case has its own test).
  await expect.poll(() => bodies.length, { timeout: 30_000 }).toBe(1);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("photo-panel")).toContainText("Cancelled");
  await expect(page.getByTestId("photo-analysing")).toHaveCount(0);

  await page.getByTestId("photo-input").setInputFiles(file);
  await expect(page.getByTestId("photo-empty")).toContainText("No foods were recognised", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("photo-empty")).toContainText("16 of 20 photos left today");

  await page.getByTestId("photo-input").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not a photo"),
  });
  await expect(page.getByTestId("photo-error")).toContainText("That file is not a photo");
  expect(bodies).toHaveLength(2); // the text file was never sent
});

test("a log that fails part way keeps the rest for a retry with the same request id, and names the allergens already logged", async ({
  page,
}) => {
  await signUp(page);
  await mockVision(page, [
    analysed([
      { query: "banana", grams: 120, confidence: 0.9 },
      { query: "oat milk", grams: 200, confidence: 0.5 },
    ]),
  ]);
  await mockSearch(page);
  const posts = await mockLogPosts(page, [201, 503], {
    2001: [avoided("peanut", "Peanut")],
    3001: [avoided("milk", "Milk")],
  });
  await openPanel(page);
  await page.getByTestId("photo-input").setInputFiles(await photoFile(page, 400, 300));
  await expect(page.getByTestId("photo-item")).toHaveCount(2, { timeout: 30_000 });
  await expect(
    page.getByTestId("photo-item").nth(1).getByRole("radio", { name: "Mock oat milk" }),
  ).toBeChecked();

  await page.getByTestId("photo-log").click();
  await expect(page.getByTestId("photo-review")).toContainText("1 logged, 1 not", {
    timeout: 30_000,
  });
  // Value: protects=the allergens of items logged before a part-way failure are named at once and
  //   still named after the retry; fails_when=the first try's alerts are dropped, so closing the panel
  //   leaves an avoided allergen in the log unnamed and the done message names only the retried items;
  //   why_new=the part-way test answered no alerts; seam=none; no_claim=the API's allergen matching
  //   (the log POST is mocked)
  await expect(page.getByTestId("photo-alerts")).toHaveText("Contains Peanut, which you avoid.");
  await expect(page.getByTestId("photo-log")).toHaveText("Log 1 item");
  await page.getByTestId("photo-log").click();
  await expect(page.getByTestId("photo-done")).toContainText("Logged 2 items", { timeout: 30_000 });
  await expect(page.getByTestId("photo-alerts")).toHaveText(
    "Contains Peanut, Milk, which you avoid.",
  );
  expect(posts).toHaveLength(3);
  expect(posts[2].requestId).toBe(posts[1].requestId); // the retry cannot log it twice
  expect(posts[2].fdcId).toBe(3001);
});

test("Home's Log by photo opens today's log with the panel; Close takes ?photo off the URL", async ({
  page,
}) => {
  await signUp(page);
  await page.goto("/");
  await page.getByTestId("log-bar-photo").click({ timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`/log/${today()}\\?photo=1$`), { timeout: 30_000 });
  await expect(page.getByTestId("photo-panel")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("photo-close").click();
  await expect(page).toHaveURL(new RegExp(`/log/${today()}$`));
  await expect(page.getByTestId("photo-panel")).toHaveCount(0);
  await expect(page.getByTestId("day-add-photo")).toBeVisible();
});

test("the photo review fits a phone screen", async ({ page }) => {
  await signUp(page);
  await page.setViewportSize({ width: 360, height: 740 });
  await mockVision(page, [analysed([{ query: "banana", grams: 120, confidence: 0.9 }])]);
  await mockSearch(page);
  await openPanel(page);
  await page.getByTestId("photo-input").setInputFiles(await photoFile(page, 400, 300));
  await expect(page.getByTestId("photo-item")).toHaveCount(1, { timeout: 30_000 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

// Value: protects=a photo is never sent after the member cancels or closes the panel, even while the
//   session is still being checked; fails_when=the abort exists only once the vision call starts, so a
//   Cancel or Close during the check is ignored and the photo goes to Anthropic (and counts toward
//   today's photos) anyway; why_new=the Cancel test cancels only once the vision call hangs;
//   seam=none; no_claim=the vision call is mocked; the session check is held with a route
test("Cancel or Close while the session is still being checked sends no photo", async ({
  page,
}) => {
  await signUp(page);
  const bodies = await mockVision(page, [analysed([], 18), analysed([], 17)]);
  await openPanel(page);
  const file = await photoFile(page, 400, 300);
  const holdNextSessionCheck = async () => {
    let arrived: () => void = () => {};
    const heldArrived = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hold = true;
    await page.route("**/api/auth/me", async (route) => {
      if (!hold) return route.fallback();
      hold = false;
      arrived();
      await released;
      await route.fallback().catch(() => {}); // the page may have given up on it meanwhile
    });
    const answered = () =>
      page.waitForResponse((r) => new URL(r.url()).pathname === "/api/auth/me");
    return { heldArrived, release, answered };
  };

  const first = await holdNextSessionCheck();
  await page.getByTestId("photo-input").setInputFiles(file);
  await first.heldArrived;
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("photo-panel")).toContainText("Cancelled");
  const firstAnswered = first.answered();
  first.release();
  await firstAnswered;

  const second = await holdNextSessionCheck();
  await page.getByTestId("photo-input").setInputFiles(file);
  await second.heldArrived;
  await page.getByTestId("photo-close").click();
  await expect(page.getByTestId("photo-panel")).toHaveCount(0);
  const secondAnswered = second.answered();
  second.release();
  await secondAnswered;

  // The next photo is the first one the vision API sees.
  await page.getByTestId("day-add-photo").click();
  await page.getByTestId("photo-input").setInputFiles(file);
  await expect(page.getByTestId("photo-empty")).toContainText("18 of 20 photos left today", {
    timeout: 30_000,
  });
  expect(bodies).toHaveLength(1);
});

test("a session check cut short by a window focus (the file dialog closing) does not refuse the photo", async ({
  page,
}) => {
  await signUp(page);
  await mockVision(page, [analysed([], 18)]);
  await openPanel(page);
  // Hold the next session check, the one the panel makes before sending the photo.
  let hold = true;
  let arrived: () => void = () => {};
  const heldArrived = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/auth/me", async (route) => {
    if (!hold) return route.fallback();
    hold = false;
    arrived();
    await released;
    await route.fallback().catch(() => {}); // the page may have given up on it meanwhile
  });
  await page.getByTestId("photo-input").setInputFiles(await photoFile(page, 400, 300));
  await heldArrived;
  // Closing the file dialog focuses the window, and the app checks the session again.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  release();
  await expect(page.getByTestId("photo-empty")).toContainText("18 of 20 photos left today", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("photo-error")).toHaveCount(0);
});

// Value: protects=a session another tab switched to another account stops the photo send and the
//   log, on every later try too, until the page is reloaded; fails_when=confirmSession is skipped
//   before analysing or before logging, or compares with the account the session now names instead
//   of the one the panel was opened for, so a second try acts as the other account; why_new=no photo
//   test changes the session's account (the focus test keeps the same one); seam=none;
//   no_claim=vision, USDA search and the log POST are mocked; the session and GET /api/auth/me are real
test("a session switched to another account in another tab stops the log and the next photo", async ({
  page,
}) => {
  await signUp(page);
  const visionBodies = await mockVision(page, [
    analysed([{ query: "banana", grams: 120, confidence: 0.9 }]),
  ]);
  await mockSearch(page);
  const posts = await mockLogPosts(page);
  await openPanel(page);
  await page.getByTestId("photo-input").setInputFiles(await photoFile(page, 400, 300));
  await expect(
    page.getByTestId("photo-item").getByRole("radio", { name: "Mock banana", exact: true }),
  ).toBeChecked({ timeout: 30_000 });

  // Another tab signs up: the cookie this page sends now names another account.
  await signUp(page);
  await page.getByTestId("photo-log").click();
  await expect(page.getByTestId("photo-review")).toContainText(
    "You are no longer signed in as this account here",
    { timeout: 30_000 },
  );
  expect(posts).toHaveLength(0);

  // Trying again is refused too: the panel stays with the account whose day this page shows, not the
  // one the session now names, until the page is reloaded.
  const checkedAgain = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/auth/me");
  await page.getByTestId("photo-log").click();
  await checkedAgain;
  await expect(page.getByTestId("photo-log")).toHaveText("Log 1 item");
  await expect(page.getByTestId("photo-review")).toContainText(
    "You are no longer signed in as this account here",
  );
  expect(posts).toHaveLength(0);

  // And before a photo is sent: Start over and a new photo are not analysed as the other account.
  await page.getByRole("button", { name: "Start over" }).click();
  await page.getByTestId("photo-input").setInputFiles(await photoFile(page, 400, 300));
  await expect(page.getByTestId("photo-error")).toContainText(
    "You are no longer signed in as this account here",
    { timeout: 30_000 },
  );
  expect(visionBodies).toHaveLength(1);
});

// Value: protects=a confirmed photo item is accepted by the real log route and, after a reload, is
//   listed as a photo estimate with its confidence; fails_when=the web's photo body and the
//   API's LogEntryCreateInput drift apart (a 400 for every photo), or the API stores it as a search
//   entry; why_new=every other photo test mocks the log POST; seam=none; no_claim=the vision and
//   search answers are mocked; on the local stack USDA's DEMO_KEY quota can skip it (a preview runs it)
test("a confirmed photo item goes through the real log route and is a photo estimate after a reload", async ({
  page,
}) => {
  await signUp(page);
  await mockVision(page, [analysed([{ query: "rolled oats", grams: 30, confidence: 0.9 }])]);
  await mockSearch(page);
  await openPanel(page);
  await page.getByTestId("photo-input").setInputFiles(await photoFile(page, 400, 300));
  await expect(
    page.getByTestId("photo-item").getByRole("radio", { name: "Mock rolled oats" }),
  ).toBeChecked({ timeout: 30_000 });
  await page.getByLabel("Meal").selectOption("breakfast");

  const posted = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/users/me/logs" && r.request().method() === "POST",
  );
  await page.getByTestId("photo-log").click();
  const answer = await posted;
  test.skip(
    answer.status() === 503 && !process.env.BASE_URL,
    "USDA unavailable on the local stack (DEMO_KEY quota spent); run against a preview",
  );
  expect(answer.status(), await answer.text()).toBe(201);
  await expect(page.getByTestId("photo-done")).toContainText("Logged 1 item", { timeout: 30_000 });

  await page.reload();
  const row = page.getByTestId("meal-breakfast").getByTestId("log-entry");
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await expect(row).toContainText("Photo estimate, 90% confidence");
  await expect(row.getByTestId("entry-grams")).toHaveText("30 g");
  const day = await page.request.get(`/api/users/me/logs?from=${today()}&to=${today()}`);
  const [entry] = LogListResponse.parse(await day.json()).entries;
  expect(entry).toMatchObject({ fdcId: 2057648, source: "photo", confidence: 0.9 });
});

// Value: protects=a member's Search again keeps its result over the item's first search, and Log waits
//   for a search still running; fails_when=searches apply in the order they finish (the queued
//   suggestion search overwrites the member's pick) or Log sends the match the item showed before the
//   new search; why_new=every search was answered at once, one per item; seam=none; no_claim=USDA
//   search and the log POST are mocked
test("Search again wins over the item's first search, and Log waits for a search still running", async ({
  page,
}) => {
  await signUp(page);
  await mockVision(page, [
    analysed([
      { query: "banana", grams: 120, confidence: 0.9 },
      { query: "oat milk", grams: 200, confidence: 0.8 },
      { query: "rolled oats", grams: 40, confidence: 0.7 },
      { query: "apple", grams: 150, confidence: 0.6 },
    ]),
  ]);
  // Searches for the words in `holding` wait until released, once each.
  const holding = new Set(["banana", "oat milk", "rolled oats"]);
  const waiting: (() => void)[] = [];
  const searched: string[] = [];
  await page.route("**/api/foods/search?*", async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") ?? "";
    searched.push(q);
    if (holding.delete(q)) await new Promise<void>((resolve) => waiting.push(resolve));
    await route.fulfill({ json: searchAnswer(q) }).catch(() => {});
  });
  const posts = await mockLogPosts(page);
  await openPanel(page);
  await page.getByTestId("photo-input").setInputFiles(await photoFile(page, 400, 300));
  const items = page.getByTestId("photo-item");
  await expect(items).toHaveCount(4, { timeout: 30_000 });
  await expect.poll(() => waiting.length).toBe(3);

  // The fourth item waits behind three searches; the member searches it with their own words.
  const fourth = items.nth(3);
  await fourth.getByLabel("Search for").fill("pear");
  await fourth.getByRole("button", { name: "Search again" }).click();
  await expect(fourth.getByRole("radio", { name: "Mock pear" })).toBeChecked({ timeout: 30_000 });
  for (const release of waiting) release();
  await expect(items.nth(2).getByRole("radio", { name: "Mock rolled oats" })).toBeChecked({
    timeout: 30_000,
  });

  // While the first item's new search runs, Log does not send the match it showed before.
  const first = items.nth(0);
  holding.add("oat milk");
  await first.getByLabel("Search for").fill("oat milk");
  await first.getByRole("button", { name: "Search again" }).click();
  await expect.poll(() => waiting.length).toBe(4);
  await page.getByTestId("photo-log").click();
  await expect(first.getByRole("alert")).toHaveText(
    "Still searching USDA. Log again when the matches show.",
  );
  expect(posts).toHaveLength(0);
  waiting[3]();
  await expect(first.getByRole("radio", { name: "Mock oat milk" })).toBeChecked({
    timeout: 30_000,
  });
  await page.getByTestId("photo-log").click();
  await expect(page.getByTestId("photo-done")).toContainText("Logged 4 items", { timeout: 30_000 });
  expect(posts.map((p) => p.fdcId)).toEqual([3001, 3001, 2057648, 4001]);
  expect(searched).not.toContain("apple"); // the member's search replaced the suggestion's
});

// Value: protects=Close waits while items are logged, and a pinch under a gram keeps its decimal;
//   fails_when=Close removes the panel mid-log (the rest is posted unseen and its alerts are lost) or
//   0.3 g shows as 0 and blocks Log; why_new=every log was answered at once and every amount was whole
//   grams; seam=none; no_claim=the log POST is mocked
test("Close waits while items are logged, and a pinch under a gram keeps its decimal", async ({
  page,
}) => {
  await signUp(page);
  await mockVision(page, [analysed([{ query: "salt", grams: 0.3, confidence: 0.6 }])]);
  await mockSearch(page);
  const posts = await mockLogPosts(page);
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/users/me/logs", async (route) => {
    if (route.request().method() === "POST") await released;
    await route.fallback();
  });
  await openPanel(page);
  await page.getByTestId("photo-input").setInputFiles(await photoFile(page, 400, 300));
  const item = page.getByTestId("photo-item");
  await expect(item.getByRole("radio", { name: "Mock salt" })).toBeChecked({ timeout: 30_000 });
  await expect(item.getByLabel("Grams")).toHaveValue("0.3");

  await page.getByTestId("photo-log").click();
  await expect(page.getByTestId("photo-log")).toHaveText("Logging…");
  await expect(page.getByTestId("photo-close")).toBeDisabled();
  release();
  await expect(page.getByTestId("photo-done")).toContainText("Logged 1 item", { timeout: 30_000 });
  await expect(page.getByTestId("photo-close")).toBeEnabled();
  expect(posts[0].grams).toBe(0.3);
});

// Value: protects=the photo panel and its reviewed items stay while the day list reloads (an entry
//   edited after another tab deleted it); fails_when=the panel goes away while the list reloads and the
//   analysis, already counted toward today's photos, is lost; why_new=no photo test reloads the day;
//   seam=none; no_claim=the day list and the entry edit are mocked
test("the reviewed items stay when the day list reloads", async ({ page }) => {
  await signUp(page);
  await mockVision(page, [analysed([{ query: "banana", grams: 120, confidence: 0.9 }])]);
  await mockSearch(page);
  let gets = 0;
  await page.route("**/api/users/me/logs?*", (route) => {
    gets += 1;
    return route.fulfill({
      json: LogListResponse.parse({
        from: today(),
        to: today(),
        entries: [
          LogEntryView.parse({
            id: "gone",
            date: today(),
            meal: "breakfast",
            fdcId: 2001,
            description: "Mock gone",
            grams: 40,
            source: "search",
            confidence: 1,
            createdAt: "2026-11-27T08:00:00.000Z",
          }),
        ],
      }),
    });
  });
  await page.route("**/api/logs/gone", (route) =>
    route.fulfill({ status: 404, json: { error: "log_not_found" } }),
  );
  await openPanel(page);
  await page.getByTestId("photo-input").setInputFiles(await photoFile(page, 400, 300));
  const banana = page
    .getByTestId("photo-item")
    .getByRole("radio", { name: "Mock banana", exact: true });
  await expect(banana).toBeChecked({ timeout: 30_000 });

  // Editing an entry another tab deleted reloads the day list.
  const before = gets;
  await page.getByRole("button", { name: "Edit Mock gone" }).click();
  await page.getByLabel("Amount (g)").fill("45");
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => gets).toBeGreaterThan(before);
  await expect(page.getByTestId("log-entry")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId("photo-review")).toBeVisible();
  await expect(banana).toBeChecked();
});

// Value: protects=each remaining vision failure offers the right way on: a failed analysis retries the
//   same photo, a photo too large asks for another, a missing profile says to save it and links there;
//   fails_when=a code falls to the default branch or loses its action, or the profile advice sends the
//   member somewhere that does not help; why_new=only the limit, refused, timeout, unavailable and
//   dropped-connection answers were tried; seam=none; no_claim=the vision API is mocked
test("a failed analysis retries, a photo too large asks for another, and a missing profile says how to fix it", async ({
  page,
}) => {
  await signUp(page);
  const bodies = await mockVision(page, [
    {
      status: 502,
      json: { error: "vision_failed", details: "The photo could not be analysed; try again" },
    },
    analysed([], 13),
    { status: 413, json: { error: "image_too_large", details: "The photo is too large" } },
    {
      status: 409,
      json: { error: "member_profile_missing", details: "Open your profile once, then try again" },
    },
  ]);
  await openPanel(page);
  const error = page.getByTestId("photo-error");
  const file = await photoFile(page, 400, 300);

  await page.getByTestId("photo-input").setInputFiles(file);
  await expect(error).toContainText("could not be analysed. Try again.", { timeout: 30_000 });
  await page.getByTestId("photo-retry").click();
  await expect(page.getByTestId("photo-empty")).toContainText("13 of 20 photos left today", {
    timeout: 30_000,
  });
  expect(bodies[1].image).toBe(bodies[0].image); // Try again resent the same photo

  await page.getByTestId("photo-input").setInputFiles(file);
  await expect(error).toContainText("too large", { timeout: 30_000 });
  await expect(page.getByTestId("photo-retry")).toHaveCount(0);

  await page.getByTestId("photo-input").setInputFiles(file);
  await expect(error).toContainText("Save any detail on your profile once", { timeout: 30_000 });
  await expect(error.getByRole("link", { name: "Open your profile" })).toHaveAttribute(
    "href",
    "/profile",
  );
  await expect(page.getByTestId("photo-retry")).toBeVisible();
  await expect(error.getByRole("link", { name: "Log by search" })).toHaveCount(0);
  await expect(page.getByTestId("photo-input")).toHaveCount(0);
});

// Value: protects=a photo that never comes back stops waiting at the browser's own limit and offers
//   Try again with the same photo; fails_when=the timer is lost or its abort is treated like Cancel, so
//   the panel waits forever or goes quiet; why_new=only the server's 504 was tried; seam=none;
//   no_claim=page.clock stands in for 90 real seconds
test("a photo that never comes back stops at the browser's limit and can be tried again", async ({
  page,
}) => {
  await page.clock.install();
  await signUp(page);
  const bodies = await mockVision(page, ["hang", analysed([], 12)]);
  await openPanel(page);
  await page.getByTestId("photo-input").setInputFiles(await photoFile(page, 400, 300));
  await expect.poll(() => bodies.length, { timeout: 30_000 }).toBe(1);
  await page.clock.fastForward(91_000);
  await expect(page.getByTestId("photo-error")).toContainText("took too long to analyse", {
    timeout: 30_000,
  });
  await page.getByTestId("photo-retry").click();
  await expect(page.getByTestId("photo-empty")).toContainText("12 of 20 photos left today", {
    timeout: 30_000,
  });
  expect(bodies[1].image).toBe(bodies[0].image);
});

// Value: protects=a retry after a lost answer keeps the item's request id through edits that change
//   nothing logged (search words typed, Remove and Add back, the same search again), so the API writes
//   the item once; fails_when=any edit clears the id, the retry sends a new one and a lost-but-written
//   entry is logged twice; why_new=the part-way test retried without touching the item; seam=none;
//   no_claim=the log POST is mocked (route.abort stands in for an answer lost after the write)
test("a retry after a lost answer keeps the request id through edits that change nothing logged", async ({
  page,
}) => {
  await signUp(page);
  await mockVision(page, [analysed([{ query: "banana", grams: 120, confidence: 0.9 }])]);
  await mockSearch(page);
  await mockLogPosts(page);
  const sent: Record<string, unknown>[] = [];
  let lose = 2; // the first two answers are lost on the way back
  await page.route("**/api/users/me/logs", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    if (lose > 0) {
      lose -= 1;
      return route.abort("internetdisconnected");
    }
    return route.fallback();
  });
  await openPanel(page);
  await page.getByTestId("photo-input").setInputFiles(await photoFile(page, 400, 300));
  const item = page.getByTestId("photo-item");
  await expect(item.getByRole("radio", { name: "Mock banana", exact: true })).toBeChecked({
    timeout: 30_000,
  });

  await page.getByTestId("photo-log").click();
  await expect.poll(() => sent.length).toBe(1);
  await expect(page.getByTestId("photo-log")).toHaveText("Log 1 item");
  // Words typed but not searched, and Remove then Add back: what would be logged is the same.
  await item.getByLabel("Search for").fill("banana split");
  await item.getByRole("button", { name: "Remove" }).click();
  await item.getByRole("button", { name: "Add back" }).click();
  await page.getByTestId("photo-log").click();
  await expect.poll(() => sent.length).toBe(2);
  await expect(page.getByTestId("photo-log")).toHaveText("Log 1 item");
  // The same search again finds the same food, which stays chosen.
  await item.getByLabel("Search for").fill("banana");
  await item.getByRole("button", { name: "Search again" }).click();
  await expect(item.getByRole("radio", { name: "Mock banana", exact: true })).toBeChecked();
  await page.getByTestId("photo-log").click();
  await expect(page.getByTestId("photo-done")).toContainText("Logged 1 item", { timeout: 30_000 });
  expect(sent).toHaveLength(3);
  expect(sent[1].requestId).toBe(sent[0].requestId);
  expect(sent[2].requestId).toBe(sent[0].requestId);
});

// Value: protects=the reviewed items stay when the day list fails to reload too; fails_when=the panel
//   is kept only through a reload that succeeds, so a failed one loses an analysis already counted
//   toward today's photos; why_new=the reload test answers the second list; seam=none; no_claim=the
//   day list and the entry edit are mocked
test("the reviewed items stay when the day list fails to reload", async ({ page }) => {
  await signUp(page);
  await mockVision(page, [analysed([{ query: "banana", grams: 120, confidence: 0.9 }])]);
  await mockSearch(page);
  let failList = false;
  await page.route("**/api/users/me/logs?*", (route) =>
    failList
      ? route.fulfill({ status: 503, json: { error: "database_unavailable" } })
      : route.fulfill({
          json: LogListResponse.parse({
            from: today(),
            to: today(),
            entries: [
              LogEntryView.parse({
                id: "gone",
                date: today(),
                meal: "breakfast",
                fdcId: 2001,
                description: "Mock gone",
                grams: 40,
                source: "search",
                confidence: 1,
                createdAt: "2026-11-27T08:00:00.000Z",
              }),
            ],
          }),
        }),
  );
  await page.route("**/api/logs/gone", (route) =>
    route.fulfill({ status: 404, json: { error: "log_not_found" } }),
  );
  await openPanel(page);
  await page.getByTestId("photo-input").setInputFiles(await photoFile(page, 400, 300));
  const banana = page
    .getByTestId("photo-item")
    .getByRole("radio", { name: "Mock banana", exact: true });
  await expect(banana).toBeChecked({ timeout: 30_000 });

  failList = true;
  await page.getByRole("button", { name: "Edit Mock gone" }).click();
  await page.getByLabel("Amount (g)").fill("45");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "database" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("photo-review")).toBeVisible();
  await expect(banana).toBeChecked();
});

// Value: protects=leaving the day while items are logged stops the items not yet sent, so nothing is
//   posted with no panel to show its result or allergen alerts; fails_when=the log loop runs on after
//   the panel is gone; why_new=only Close was held back during logging; seam=none; no_claim=the log
//   POST is mocked
test("leaving the day while items are logged stops the items not yet sent", async ({ page }) => {
  await signUp(page);
  await mockVision(page, [
    analysed([
      { query: "banana", grams: 120, confidence: 0.9 },
      { query: "oat milk", grams: 200, confidence: 0.8 },
    ]),
  ]);
  await mockSearch(page);
  const posts = await mockLogPosts(page);
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived = 0;
  await page.route("**/api/users/me/logs", async (route) => {
    if (route.request().method() === "POST") {
      arrived += 1;
      await released;
    }
    await route.fallback();
  });
  await openPanel(page);
  await page.getByTestId("photo-input").setInputFiles(await photoFile(page, 400, 300));
  await expect(
    page.getByTestId("photo-item").nth(1).getByRole("radio", { name: "Mock oat milk" }),
  ).toBeChecked({ timeout: 30_000 });

  await page.getByTestId("photo-log").click();
  await expect.poll(() => arrived).toBe(1);
  await page.getByRole("link", { name: /Previous day/ }).click();
  await expect(page.getByTestId("photo-panel")).toHaveCount(0);
  const firstAnswered = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/users/me/logs" && r.request().method() === "POST",
  );
  release();
  await firstAnswered;
  // gstack-timing-ok: an absence check; the old loop sent the next item within milliseconds
  await page.waitForTimeout(1_000);
  expect(arrived).toBe(1);
  expect(posts).toHaveLength(1);
});

// Value: protects=a photo the browser cannot decode is refused with a clear message before anything
//   is sent; fails_when=the decode failure is shown as another problem, the panel stalls on
//   "Preparing", or the file is sent anyway; why_new=only a file that is not an image type was tried;
//   seam=none; no_claim=other browsers' decoders (Chromium only)
test("a photo the browser cannot open is refused before anything is sent", async ({ page }) => {
  await signUp(page);
  const bodies = await mockVision(page, []);
  await openPanel(page);
  await page.getByTestId("photo-input").setInputFiles({
    name: "meal.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("not really a photo"),
  });
  await expect(page.getByTestId("photo-error")).toContainText(
    "This browser cannot open that photo",
    {
      timeout: 30_000,
    },
  );
  await expect(page.getByTestId("photo-retry")).toHaveCount(0);
  expect(bodies).toHaveLength(0);
});

// Value: protects=an item logged while the day list reloads still shows in the list afterwards, once;
//   fails_when=the logged entry is dropped because the list was loading, or shown twice when the
//   reload already had it; why_new=no test logs while the list reloads; seam=none; no_claim=the day
//   list, the entry edit and the log POST are mocked
test("an item logged while the day list reloads still shows in the list", async ({ page }) => {
  await signUp(page);
  await mockVision(page, [analysed([{ query: "banana", grams: 120, confidence: 0.9 }])]);
  await mockSearch(page);
  await mockLogPosts(page);
  let releasePost: () => void = () => {};
  const postReleased = new Promise<void>((resolve) => {
    releasePost = resolve;
  });
  await page.route("**/api/users/me/logs", async (route) => {
    if (route.request().method() === "POST") await postReleased;
    await route.fallback();
  });
  let holdList = false;
  let listHeld = false;
  let releaseList: () => void = () => {};
  const listReleased = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  await page.route("**/api/users/me/logs?*", async (route) => {
    if (holdList) {
      listHeld = true;
      await listReleased;
    }
    await route
      .fulfill({
        json: LogListResponse.parse({
          from: today(),
          to: today(),
          entries: [
            LogEntryView.parse({
              id: "gone",
              date: today(),
              meal: "breakfast",
              fdcId: 2001,
              description: "Mock gone",
              grams: 40,
              source: "search",
              confidence: 1,
              createdAt: "2026-11-27T08:00:00.000Z",
            }),
          ],
        }),
      })
      .catch(() => {});
  });
  await page.route("**/api/logs/gone", (route) =>
    route.fulfill({ status: 404, json: { error: "log_not_found" } }),
  );
  await openPanel(page);
  await page.getByTestId("photo-input").setInputFiles(await photoFile(page, 400, 300));
  await expect(
    page.getByTestId("photo-item").getByRole("radio", { name: "Mock banana", exact: true }),
  ).toBeChecked({ timeout: 30_000 });
  await page.getByLabel("Meal").selectOption("lunch");

  await page.getByTestId("photo-log").click();
  await expect(page.getByTestId("photo-log")).toHaveText("Logging…");
  // The list reloads (an entry another tab deleted) while the photo item is being logged.
  holdList = true;
  await page.getByRole("button", { name: "Edit Mock gone" }).click();
  await page.getByLabel("Amount (g)").fill("45");
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => listHeld).toBe(true);
  releasePost();
  await expect(page.getByTestId("photo-done")).toContainText("Logged 1 item", { timeout: 30_000 });
  releaseList();
  const lunch = page.getByTestId("meal-lunch").getByTestId("log-entry");
  await expect(lunch).toHaveCount(1, { timeout: 30_000 });
  await expect(lunch).toContainText("Photo estimate");
});
