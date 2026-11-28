import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import {
  AllergenListResponse,
  AllergenWriteResponse,
  RematchProgress,
  UnmatchedListResponse,
  UnmatchedTokenView,
} from "../packages/shared/src/index";
import type { TokenStatus, UnmatchedTokenView as Token } from "../packages/shared/src/index";
import { makeAccount } from "./helpers";
import { CURATOR_PROFILE, DICTIONARY, GLUTEN_ID, MILK_ID, mockSession } from "./role-mocks";

// Lane B, T22 web half (#20): /curate/unmatched?status=&page=, the unmatched-ingredient queue (design
// doc, Pages table, phase 3). The Curator session and the queue routes are mocked (e2e/role-mocks.ts
// says why: no spec can obtain the Curator role on a preview), each mock parsed with the shared schema;
// what a member and a signed-out visitor see comes from the real stack.

// Reviewed dates are shown as the viewer's day: a fixed zone keeps the fixtures' days fixed.
test.use({ timezoneId: "UTC" });

function token(over: Partial<Token> & { token: string }): Token {
  return UnmatchedTokenView.parse({
    count: 1,
    sampleFdcIds: [],
    status: "new",
    reviewedAt: null,
    ...over,
  });
}

type Put = { token: string; body: unknown };
type Answer = { status: number; json: unknown };

/**
 * A Curator session; GET /api/curate/unmatched answers `lists[status]` (sliced into pages of 20 with
 * `total` as given, or the list's length), PUT /api/curate/unmatched/:token answers `answers` in turn.
 */
async function asCurator(
  page: Page,
  opts: {
    lists?: Partial<Record<TokenStatus, { tokens: Token[]; total?: number }>>;
    answers?: Answer[];
    dictionaryFails?: boolean;
  } = {},
) {
  await mockSession(page, {
    username: "mock_curator",
    roles: ["member", "curator"],
    activeRole: "curator",
  });
  let dictionaryFails = opts.dictionaryFails ?? false;
  await page.route("**/api/allergens", (route) =>
    dictionaryFails
      ? route.fulfill({ status: 503, json: { error: "database_unavailable" } })
      : route.fulfill({ json: AllergenListResponse.parse(DICTIONARY) }),
  );
  await page.route("**/api/users/me/profiles/curator", (route) =>
    route.fulfill({ json: CURATOR_PROFILE }),
  );
  const gets: { status: string | null; page: string | null }[] = [];
  const puts: Put[] = [];
  const answers = [...(opts.answers ?? [])];
  await page.route(
    (url) => url.pathname.startsWith("/api/curate/unmatched"),
    (route: Route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() === "GET") {
        const status = (url.searchParams.get("status") ?? "new") as TokenStatus;
        const pageNo = Number(url.searchParams.get("page") ?? "1");
        gets.push({ status: url.searchParams.get("status"), page: url.searchParams.get("page") });
        const list = opts.lists?.[status] ?? { tokens: [] };
        return route.fulfill({
          json: UnmatchedListResponse.parse({
            tokens: list.tokens.slice((pageNo - 1) * 20, pageNo * 20),
            page: pageNo,
            total: list.total ?? list.tokens.length,
          }),
        });
      }
      // The raw path, so the spec sees how the page encoded the phrase.
      puts.push({
        token: url.pathname.slice("/api/curate/unmatched/".length),
        body: req.postDataJSON(),
      });
      const answer = answers.shift() ?? { status: 500, json: { error: "unexpected" } };
      return route.fulfill({ status: answer.status, json: answer.json });
    },
  );
  return {
    gets,
    puts,
    failDictionary: (fail: boolean) => {
      dictionaryFails = fail;
    },
  };
}

const NEW = [
  token({ token: "xanthan gum", count: 14, sampleFdcIds: [2001, 2002, 2003] }),
  token({ token: "soy lecithin powder", count: 6, sampleFdcIds: [2004] }),
  token({ token: "and/or soybean oil", count: 1 }),
];

function mapped(id: string, done = true): Answer {
  const allergen = DICTIONARY.allergens.find((a) => a.id === id)!;
  return {
    status: done ? 200 : 202,
    json: {
      token: token({ token: "x", status: "mapped", reviewedAt: "2026-11-26T10:00:00.000Z" }),
      write: AllergenWriteResponse.parse({
        allergen: { ...allergen, rematchPending: !done },
        rematch: done
          ? { done: true, processed: 900, remaining: 0 }
          : { done: false, processed: 300, remaining: 600 },
      }),
    },
  };
}

test("Curator Home links to the queue; the queue lists phrases, most foods first, with examples", async ({
  page,
}) => {
  const { gets } = await asCurator(page, { lists: { new: { tokens: NEW } } });
  await page.goto("/");
  const tile = page.getByTestId("tile-unmatched");
  await expect(tile).toContainText("3 ingredient phrases matched no synonym", { timeout: 30_000 });
  await tile.getByTestId("unmatched-link").click();
  await expect(page).toHaveURL(/\/curate\/unmatched$/);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Unmatched ingredients");
  await expect(page.getByTestId("tab-new")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("unmatched-total")).toHaveText("3 phrases");
  const rows = page.getByTestId("unmatched-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("xanthan gum");
  await expect(rows.nth(0)).toContainText("in 14 cached foods");
  await expect(rows.nth(0)).toContainText("For example:");
  // Each row's allergen select has a name of its own, for a screen reader moving between rows.
  await expect(
    rows.nth(0).getByRole("combobox", {
      name: `Allergen for ${await rows.nth(0).getAttribute("data-token")}`,
    }),
  ).toBeVisible();
  await expect(rows.nth(0).getByRole("link", { name: "food 2002" })).toHaveAttribute(
    "href",
    "/food/2002",
  );
  await expect(rows.nth(2)).toContainText("in 1 cached food");
  // New phrases can be mapped or ignored; the allergens come from the dictionary.
  await expect(rows.nth(0).getByLabel(/^Allergen for /)).toContainText("Gluten");
  await expect(rows.nth(0).getByRole("button", { name: "Ignore “xanthan gum”" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Allergen dictionary" })).toHaveAttribute(
    "href",
    "/curate/allergens",
  );
  expect(gets.at(-1)).toEqual({ status: "new", page: "1" });

  // The dictionary page links here too.
  await page.goto("/curate/allergens");
  await page.getByRole("link", { name: "Unmatched ingredients" }).click();
  await expect(page).toHaveURL(/\/curate\/unmatched$/);
});

test("map a phrase to an allergen: nothing is sent until one is chosen, then it is added as a synonym", async ({
  page,
}) => {
  const { puts } = await asCurator(page, {
    lists: { new: { tokens: NEW } },
    answers: [mapped(MILK_ID)],
  });
  await page.goto("/curate/unmatched");
  const row = page.getByTestId("unmatched-row").filter({ hasText: "soy lecithin powder" });
  await expect(row).toBeVisible({ timeout: 30_000 });

  await row.getByRole("button", { name: "Map “soy lecithin powder”" }).click();
  await expect(row.getByTestId("unmatched-row-error")).toHaveText(
    "Pick the allergen this phrase names.",
  );
  expect(puts).toHaveLength(0);

  await row.getByLabel(/^Allergen for /).selectOption({ label: "Milk" });
  await expect(row.getByTestId("unmatched-row-error")).toHaveCount(0);
  await row.getByRole("button", { name: "Map “soy lecithin powder”" }).click();
  const done = row.getByTestId("unmatched-mapped");
  await expect(done).toContainText(
    "Added “soy lecithin powder” to the synonyms of Milk. Every cached food has been re-matched.",
  );
  await expect(done.getByRole("link", { name: "Milk" })).toHaveAttribute(
    "href",
    "/curate/allergens/milk",
  );
  // The actions are gone from that row; the others keep theirs.
  await expect(row.getByLabel(/^Allergen for /)).toHaveCount(0);
  await expect(
    page
      .getByTestId("unmatched-row")
      .nth(0)
      .getByLabel(/^Allergen for /),
  ).toBeVisible();
  expect(puts).toEqual([
    {
      token: "soy%20lecithin%20powder",
      body: { action: "map", allergenId: MILK_ID },
    },
  ]);
});

test("a map whose re-match ran out of time offers Continue re-match until it is done", async ({
  page,
}) => {
  await asCurator(page, { lists: { new: { tokens: NEW } }, answers: [mapped(GLUTEN_ID, false)] });
  const rematches: string[] = [];
  await page.route("**/api/curate/allergens/*/rematch", (route) => {
    rematches.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      json: RematchProgress.parse({ done: true, processed: 600, remaining: 0 }),
    });
  });
  await page.goto("/curate/unmatched");
  const row = page.getByTestId("unmatched-row").first();
  await row.getByLabel(/^Allergen for /).selectOption({ label: "Gluten" });
  await row.getByRole("button", { name: "Map “xanthan gum”" }).click();
  await expect(row.getByTestId("unmatched-mapped")).toContainText(
    "Added “xanthan gum” to the synonyms of Gluten.",
    { timeout: 30_000 },
  );
  await expect(row.getByTestId("rematch-pending")).toContainText("600 foods left to re-match");
  await row.getByRole("button", { name: "Continue re-match for Gluten" }).click();
  await expect(row.getByTestId("rematch-done")).toHaveText("Re-match done");
  expect(rematches).toEqual([`/api/curate/allergens/${GLUTEN_ID}/rematch`]);
});

test("ignore a phrase; a phrase with a slash is sent encoded", async ({ page }) => {
  const { puts } = await asCurator(page, {
    lists: { new: { tokens: NEW } },
    answers: [
      {
        status: 200,
        json: {
          token: token({
            token: "and/or soybean oil",
            status: "ignored",
            reviewedAt: "2026-11-26T10:00:00.000Z",
          }),
          write: null,
        },
      },
    ],
  });
  await page.goto("/curate/unmatched");
  const row = page.getByTestId("unmatched-row").filter({ hasText: "and/or soybean oil" });
  await row.getByRole("button", { name: "Ignore “and/or soybean oil”" }).click();
  await expect(row.getByTestId("unmatched-ignored")).toHaveText(
    "Ignored. It is listed under Ignored, where it can still be mapped.",
    { timeout: 30_000 },
  );
  expect(puts).toEqual([{ token: "and%2For%20soybean%20oil", body: { action: "ignore" } }]);
});

test("the API's refusals are explained on the row and leave its actions in place", async ({
  page,
}) => {
  await asCurator(page, {
    lists: { new: { tokens: NEW } },
    answers: [
      { status: 409, json: { error: "token_excluded" } },
      { status: 409, json: { error: "synonyms_full" } },
      { status: 404, json: { error: "allergen_not_found" } },
      { status: 404, json: { error: "token_not_found" } },
      { status: 409, json: { error: "token_mapped" } },
    ],
  });
  await page.goto("/curate/unmatched");
  const row = page.getByTestId("unmatched-row").first();
  const error = row.getByTestId("unmatched-row-error");
  const map = row.getByRole("button", { name: "Map “xanthan gum”" });
  await row.getByLabel(/^Allergen for /).selectOption({ label: "Gluten" });

  await map.click();
  await expect(error).toHaveText(
    "That allergen’s exclude phrases hide this phrase, so it could never match. Pick another allergen, or edit its exclude phrases first.",
    { timeout: 30_000 },
  );
  await map.click();
  await expect(error).toHaveText(
    "That allergen already holds 200 synonyms, the most an entry can have. Nothing was changed.",
  );
  await map.click();
  await expect(error).toHaveText(
    "That allergen no longer exists; another Curator may have deleted it. Reload the list.",
  );
  await map.click();
  await expect(error).toHaveText("This phrase is no longer in the queue. Reload the list.");
  await row.getByRole("button", { name: "Ignore “xanthan gum”" }).click();
  await expect(error).toHaveText(
    "This phrase is already mapped to an allergen, so it cannot be ignored.",
  );
  await expect(map).toBeEnabled();
});

test("tabs and pages live in the URL; ignored phrases can still be mapped, mapped ones are read-only", async ({
  page,
}) => {
  const many = Array.from({ length: 45 }, (_, i) =>
    token({ token: `phrase ${String(i + 1).padStart(2, "0")}`, count: 50 - i }),
  );
  const { gets } = await asCurator(page, {
    lists: {
      new: { tokens: many },
      ignored: {
        tokens: [
          token({ token: "natural flavor", status: "ignored", reviewedAt: "2026-11-24T12:00:00Z" }),
        ],
      },
      mapped: {
        tokens: [
          token({ token: "whey powder", status: "mapped", reviewedAt: "2026-11-20T09:00:00Z" }),
        ],
      },
    },
  });
  await page.goto("/curate/unmatched");
  await expect(page.getByTestId("unmatched-page")).toHaveText("Page 1 of 3", { timeout: 30_000 });
  await expect(page.getByTestId("unmatched-total")).toHaveText("45 phrases");
  await page.getByRole("link", { name: "Next →" }).click();
  await expect(page).toHaveURL(/\/curate\/unmatched\?page=2$/);
  await expect(page.getByTestId("unmatched-row").first()).toContainText("phrase 21");
  await expect(page.getByTestId("unmatched-page")).toHaveText("Page 2 of 3");
  await page.goBack();
  await expect(page.getByTestId("unmatched-row").first()).toContainText("phrase 01");

  await page.getByTestId("tab-ignored").click();
  await expect(page).toHaveURL(/\/curate\/unmatched\?status=ignored$/);
  const ignored = page.getByTestId("unmatched-row");
  await expect(ignored).toHaveCount(1);
  await expect(ignored).toContainText("Ignored Nov 24, 2026");
  await expect(ignored.getByLabel(/^Allergen for /)).toBeVisible();
  await expect(ignored.getByRole("button", { name: /^Ignore/ })).toHaveCount(0);

  await page.getByTestId("tab-mapped").click();
  await expect(page).toHaveURL(/\/curate\/unmatched\?status=mapped$/);
  const mappedRow = page.getByTestId("unmatched-row");
  await expect(mappedRow).toContainText("Mapped Nov 20, 2026");
  await expect(mappedRow.getByLabel(/^Allergen for /)).toHaveCount(0);
  await expect(mappedRow.getByRole("button")).toHaveCount(0);
  // Each tab asks for its own status (repeats collapsed: dev mode runs effects twice).
  const asked = gets.map((g) => g.status).filter((s, i, all) => s !== all[i - 1]);
  expect(asked).toEqual(["new", "ignored", "mapped"]);

  // A hand-edited URL with an unknown status or a bad page shows the new phrases, page 1.
  await page.goto("/curate/unmatched?status=bogus&page=0");
  await expect(page.getByTestId("tab-new")).toHaveAttribute("aria-current", "page", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("unmatched-page")).toHaveText("Page 1 of 3");
  // A page past the end says so and links back.
  await page.goto("/curate/unmatched?page=9");
  await expect(page.getByTestId("unmatched-empty")).toContainText(
    "Page 9 is past the end of this list.",
    { timeout: 30_000 },
  );
  // The last page that has phrases is one link away, as well as the first.
  await expect(page.getByRole("link", { name: "Go to page 3" })).toHaveAttribute(
    "href",
    "/curate/unmatched?page=3",
  );
  await page.getByRole("link", { name: "Go to page 1" }).click();
  await expect(page).toHaveURL(/\/curate\/unmatched$/);
});

test("a page that exists but comes back empty says so without claiming it is past the end", async ({
  page,
}) => {
  // Phrases reviewed elsewhere between the count and the list: page 1 of 2 holds nothing.
  await asCurator(page, { lists: { new: { tokens: [], total: 25 } } });
  await page.goto("/curate/unmatched");
  const empty = page.getByTestId("unmatched-empty");
  await expect(empty).toHaveText("No phrases on this page.", { timeout: 30_000 });
  await expect(empty.getByRole("link")).toHaveCount(0);
});

test("empty lists say so, and a failed load offers Try again", async ({ page }) => {
  const control = await asCurator(page, { dictionaryFails: true, lists: { new: { tokens: NEW } } });
  await page.goto("/curate/unmatched");
  // The dictionary failed: the phrases still show, mapping waits for it.
  await expect(page.getByTestId("unmatched-dictionary-error")).toContainText(
    "Could not load the allergens to map to.",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("unmatched-dictionary-error")).toContainText(
    "The database is not answering right now.",
  );
  await expect(
    page
      .getByTestId("unmatched-row")
      .first()
      .getByLabel(/^Allergen for /),
  ).toBeDisabled();
  // It says so, rather than still "Loading allergens…".
  await expect(
    page
      .getByTestId("unmatched-row")
      .first()
      .getByLabel(/^Allergen for /),
  ).toContainText("Allergens unavailable");
  control.failDictionary(false);
  await page.getByTestId("unmatched-dictionary-error").getByRole("button").click();
  await expect(
    page
      .getByTestId("unmatched-row")
      .first()
      .getByLabel(/^Allergen for /),
  ).toBeEnabled();

  await page.goto("/curate/unmatched?status=mapped");
  await expect(page.getByTestId("unmatched-empty")).toHaveText(
    "No phrases have been mapped to an allergen yet.",
    { timeout: 30_000 },
  );
  // Registered last, so it answers before the queue mock.
  await page.route("**/api/curate/unmatched?*", (route) =>
    route.fulfill({ status: 503, json: { error: "database_unavailable" } }),
  );
  await page.goto("/curate/unmatched");
  await expect(page.getByTestId("unmatched-list-error")).toContainText(
    "Could not load the ingredient phrases.",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("unmatched-list-error")).toContainText(
    "The database is not answering right now.",
  );
  await expect(page.getByTestId("unmatched-list-error").getByRole("button")).toHaveText(
    "Try again",
  );
});

test("from the real API: a member is told the page is not theirs, and the queue refuses them", async ({
  page,
}) => {
  const account = makeAccount("um");
  const res = await page.request.post("/api/auth/register", { data: account });
  expect(res.status(), await res.text()).toBe(201);
  await page.goto("/curate/unmatched");
  await expect(page.getByTestId("role-required")).toContainText("This page is for Curators", {
    timeout: 30_000,
  });
  const api = await page.request.get("/api/curate/unmatched");
  expect(api.status()).toBe(403);
});

test("signed-out visitors are sent to log in", async ({ page }) => {
  await page.goto("/curate/unmatched?status=ignored");
  await expect(page).toHaveURL(/\/login$/, { timeout: 30_000 });
});

test("no horizontal scrolling at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await asCurator(page, {
    lists: {
      new: {
        tokens: [
          ...NEW,
          token({
            token: "an unusually long ingredient phrase from a label with many qualifiers",
            count: 3,
            sampleFdcIds: [1999999, 2999999, 3999999, 4999999, 5999999],
          }),
        ],
      },
    },
  });
  await page.goto("/curate/unmatched");
  await expect(page.getByTestId("unmatched-row")).toHaveCount(4, { timeout: 30_000 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("working through a page never skips the phrases after it", async ({ page }) => {
  const many = Array.from({ length: 21 }, (_, i) =>
    token({ token: `phrase ${String(i + 1).padStart(2, "0")}`, count: 50 - i }),
  );
  await asCurator(page);
  // A queue the server shrinks as phrases are ignored, as the real one does (registered last, so it
  // answers before asCurator's static lists).
  let queue = [...many];
  await page.route(
    (url) => url.pathname.startsWith("/api/curate/unmatched"),
    (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() === "GET") {
        const pageNo = Number(url.searchParams.get("page") ?? "1");
        return route.fulfill({
          json: UnmatchedListResponse.parse({
            tokens: queue.slice((pageNo - 1) * 20, pageNo * 20),
            page: pageNo,
            total: queue.length,
          }),
        });
      }
      const name = decodeURIComponent(url.pathname.slice("/api/curate/unmatched/".length));
      queue = queue.filter((t) => t.token !== name);
      return route.fulfill({
        json: {
          token: token({ token: name, status: "ignored", reviewedAt: "2026-11-26T12:00:00.000Z" }),
          write: null,
        },
      });
    },
  );

  await page.goto("/curate/unmatched");
  await expect(page.getByTestId("unmatched-page")).toHaveText("Page 1 of 2", { timeout: 30_000 });
  await page.getByRole("button", { name: "Ignore “phrase 01”" }).click();
  await expect(page.getByTestId("unmatched-ignored")).toBeVisible();
  // Moving on, by whatever the pager offers, shows phrase 21: it moved up into this page.
  await page
    .getByRole("link", { name: "Next →" })
    .or(page.getByRole("button", { name: "Show the next phrases" }))
    .click();
  await expect(page.getByTestId("unmatched-row").filter({ hasText: "phrase 21" })).toBeVisible({
    timeout: 30_000,
  });
});

test("one map at a time: the other rows wait while a map re-matches, and focus lands on the outcome", async ({
  page,
}) => {
  await asCurator(page, { lists: { new: { tokens: NEW } } });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname.startsWith("/api/curate/unmatched/"),
    async (route) => {
      await held;
      return route.fulfill({ json: mapped(MILK_ID).json });
    },
  );
  await page.goto("/curate/unmatched");
  const rows = page.getByTestId("unmatched-row");
  await rows
    .nth(0)
    .getByLabel(/^Allergen for /)
    .selectOption({ label: "Milk" }, { timeout: 30_000 });
  await rows.nth(0).getByRole("button", { name: /^Map/ }).click();
  await expect(rows.nth(1).getByRole("button", { name: /^Map/ })).toBeDisabled();
  // The waiting row says which re-match it waits for; Ignore needs no re-match and stays available.
  await expect(rows.nth(1).getByTestId("unmatched-map-waits")).toHaveText(
    "Map waits until the Milk re-match finishes.",
  );
  await expect(rows.nth(0).getByTestId("unmatched-map-waits")).toHaveCount(0);
  // The disabled Map is skipped by Tab, so the select, which keeps focus, carries the reason.
  await expect(rows.nth(1).getByLabel(/^Allergen for /)).toHaveAccessibleDescription(
    "Map waits until the Milk re-match finishes.",
  );
  // One live message says it once for the page, rather than once per waiting row.
  await expect(page.getByTestId("unmatched-announce")).toHaveText(
    "Map waits until the Milk re-match finishes.",
  );
  await expect(rows.nth(1).getByRole("button", { name: /^Ignore/ })).toBeEnabled();
  release();
  await expect(rows.nth(0).getByTestId("unmatched-mapped")).toBeFocused();
  await expect(rows.nth(1).getByRole("button", { name: /^Map/ })).toBeEnabled();
  await expect(rows.nth(1).getByTestId("unmatched-map-waits")).toHaveCount(0);
  await expect(page.getByTestId("unmatched-announce")).toHaveText(
    "The re-match finished. Map is available again.",
  );
});

test("the Mapped tab, where nothing can be mapped, does not load the dictionary", async ({
  page,
}) => {
  await asCurator(page, {
    lists: {
      mapped: {
        tokens: [
          token({ token: "whey powder", status: "mapped", reviewedAt: "2026-11-20T12:00:00Z" }),
        ],
      },
    },
  });
  let dictionaryGets = 0;
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/allergens") dictionaryGets += 1;
  });
  await page.goto("/curate/unmatched?status=mapped");
  await expect(page.getByTestId("unmatched-row")).toHaveCount(1, { timeout: 30_000 });
  expect(dictionaryGets).toBe(0);
});

test("a map that answers late does not pull focus away from another row the Curator moved to", async ({
  page,
}) => {
  await asCurator(page, { lists: { new: { tokens: NEW } } });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname.startsWith("/api/curate/unmatched/"),
    async (route) => {
      await held;
      return route.fulfill({ json: mapped(MILK_ID).json });
    },
  );
  await page.goto("/curate/unmatched");
  const rows = page.getByTestId("unmatched-row");
  await rows
    .nth(0)
    .getByLabel(/^Allergen for /)
    .selectOption({ label: "Milk" }, { timeout: 30_000 });
  await rows.nth(0).getByRole("button", { name: /^Map/ }).click();
  // While it re-matches, the Curator moves on to the next phrase.
  const next = rows.nth(1).getByLabel(/^Allergen for /);
  await next.focus();
  release();
  await expect(rows.nth(0).getByTestId("unmatched-mapped")).toBeVisible();
  await expect(next).toBeFocused();
});

test("one heavy job at a time: a running Continue holds the other rows' Map, and a running Map holds Continue", async ({
  page,
}) => {
  // Row 0's map answers 202, so it offers Continue re-match; row 1's map is held until released.
  await asCurator(page, { lists: { new: { tokens: NEW } }, answers: [mapped(MILK_ID, false)] });
  await page.goto("/curate/unmatched");
  const rows = page.getByTestId("unmatched-row");
  await rows
    .nth(0)
    .getByLabel(/^Allergen for /)
    .selectOption({ label: "Milk" }, { timeout: 30_000 });
  await rows.nth(0).getByRole("button", { name: /^Map/ }).click();
  const resume = rows.nth(0).getByRole("button", { name: /Continue re-match/ });
  await expect(resume).toBeVisible();

  // A Map elsewhere holds this row's Continue.
  let releaseMap: () => void = () => {};
  const mapHeld = new Promise<void>((resolve) => {
    releaseMap = resolve;
  });
  await page.route(
    (url) => url.pathname.startsWith("/api/curate/unmatched/"),
    async (route) => {
      await mapHeld;
      return route.fulfill({ json: mapped(GLUTEN_ID).json });
    },
  );
  await rows
    .nth(1)
    .getByLabel(/^Allergen for /)
    .selectOption({ label: "Gluten" });
  await rows.nth(1).getByRole("button", { name: /^Map/ }).click();
  await expect(resume).toBeDisabled();
  releaseMap();
  await expect(rows.nth(1).getByTestId("unmatched-mapped")).toBeVisible();
  await expect(resume).toBeEnabled();

  // A running Continue holds the other rows' Map until it ends.
  let releaseContinue: () => void = () => {};
  const continueHeld = new Promise<void>((resolve) => {
    releaseContinue = resolve;
  });
  await page.route("**/api/curate/allergens/*/rematch", async (route) => {
    await continueHeld;
    return route.fulfill({
      json: RematchProgress.parse({ done: true, processed: 600, remaining: 0 }),
    });
  });
  await resume.click();
  await expect(rows.nth(2).getByRole("button", { name: /^Map/ })).toBeDisabled();
  releaseContinue();
  await expect(rows.nth(0).getByTestId("rematch-done")).toBeVisible();
  await expect(rows.nth(2).getByRole("button", { name: /^Map/ })).toBeEnabled();
});
