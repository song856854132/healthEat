import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  AllergenListResponse,
  AllergenWriteResponse,
  CuratorProfileView,
  RematchProgress,
  UnmatchedListResponse,
} from "../packages/shared/src/index";
import type { AllergenView } from "../packages/shared/src/index";
import { CURATOR_PROFILE, DICTIONARY, GLUTEN_ID, MILK_ID, mockSession } from "./role-mocks";

// Lane B (T21 web half): Curator Home and the dictionary pages, /curate/allergens and
// /curate/allergens/[key] (design doc, Pages table: dictionary CRUD, re-match status and "Continue
// re-match"). The session and the routes are mocked (e2e/role-mocks.ts says why); each spec checks
// what the page sends as well as what it shows.

type Dictionary = { allergens: AllergenView[] };

/** A Curator session with the dictionary served from `dictionary` (mutable, so writes can change it). */
async function asCurator(page: Page, dictionary: Dictionary = structuredClone(DICTIONARY)) {
  await mockSession(page, {
    username: "mock_curator",
    roles: ["member", "curator"],
    activeRole: "curator",
  });
  await page.route("**/api/allergens", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: AllergenListResponse.parse(dictionary) })
      : route.fallback(),
  );
  await page.route("**/api/curate/unmatched*", (route) =>
    route.fulfill({ json: UnmatchedListResponse.parse({ tokens: [], page: 1, total: 12 }) }),
  );
  await page.route("**/api/users/me/profiles/curator", (route) =>
    route.fulfill({ json: CURATOR_PROFILE }),
  );
  return dictionary;
}

test("Curator Home: dictionary health, an unfinished re-match to continue, your edits and the queue", async ({
  page,
}) => {
  const dictionary = await asCurator(page);
  const answers = [
    RematchProgress.parse({ done: false, processed: 100, remaining: 410 }),
    RematchProgress.parse({ done: true, processed: 410, remaining: 0 }),
  ];
  const rematches: string[] = [];
  await page.route("**/api/curate/allergens/*/rematch", (route) => {
    rematches.push(new URL(route.request().url()).pathname);
    const progress = answers.shift()!;
    if (progress.done) dictionary.allergens[0].rematchPending = false;
    return route.fulfill({ status: progress.done ? 200 : 202, json: progress });
  });

  await page.goto("/");
  const home = page.getByTestId("curator-home");
  await expect(home).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByTestId("curator-dictionary").getByRole("heading", { level: 2 }),
  ).toHaveText("Allergen dictionary (2 allergens · 5 synonyms)");
  const rows = page.getByTestId("dictionary-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Sensitivity");
  await expect(rows.nth(0)).toContainText("wheat, barley, rye");
  await expect(rows.nth(1).getByRole("link", { name: "Milk" })).toHaveAttribute(
    "href",
    "/curate/allergens/milk",
  );
  await expect(rows.nth(1)).toContainText("edited");
  await expect(page.getByTestId("curator-edits")).toContainText("Milk");
  await expect(page.getByTestId("tile-edits")).toContainText("3 dictionary edits by you");
  await expect(page.getByTestId("tile-unmatched")).toContainText("12");
  await expect(page.getByTestId("rematch-summary")).toContainText("1 re-match is unfinished");

  // Continue re-match: 202 with foods left, then 200 done, which reloads the dictionary.
  const resume = page.getByRole("button", { name: "Continue re-match for Gluten" });
  await resume.click();
  await expect(rows.nth(0)).toContainText("410 foods left to re-match");
  await resume.click();
  await expect(page.getByTestId("rematch-summary")).toContainText("No re-match in progress");
  await expect(rows.nth(0)).toContainText("done");
  expect(rematches).toEqual([
    `/api/curate/allergens/${GLUTEN_ID}/rematch`,
    `/api/curate/allergens/${GLUTEN_ID}/rematch`,
  ]);

  await page.getByTestId("nav-dictionary").click();
  await expect(page).toHaveURL(/\/curate\/allergens$/, { timeout: 30_000 });
  await expect(page.getByTestId("allergen-row")).toHaveCount(2);
});

test("Add allergen: checked before sending, a taken key is refused, and the new entry opens", async ({
  page,
}) => {
  const dictionary = await asCurator(page);
  const posted: unknown[] = [];
  await page.route("**/api/allergens", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as Omit<AllergenView, "id" | "source">;
    posted.push(body);
    if (body.key === "milk")
      return route.fulfill({
        status: 409,
        json: { error: "conflict", details: { fields: ["key"] } },
      });
    const allergen = {
      ...body,
      id: "64b000000000000000000003",
      source: "curator" as const,
      rematchPending: false,
    };
    dictionary.allergens.push(allergen);
    return route.fulfill({
      status: 201,
      json: AllergenWriteResponse.parse({
        allergen,
        rematch: { done: true, processed: 7, remaining: 0 },
      }),
    });
  });

  await page.goto("/curate/allergens");
  await page.getByRole("link", { name: "Add allergen" }).click();
  await expect(page).toHaveURL(/\/curate\/allergens\/new$/, { timeout: 30_000 });
  const form = page.getByTestId("allergen-form");

  // Nothing filled in: every problem is shown and nothing is sent.
  await form.getByRole("button", { name: "Add allergen" }).click();
  await expect(page.locator("#field-key-error")).toBeVisible();
  await expect(page.locator("#field-displayName-error")).toContainText("Give the allergen a name");
  await expect(page.locator("#field-synonyms-error")).toContainText("at least one synonym");
  await page.getByLabel("Key", { exact: true }).fill("Tree Nuts!");
  await page.getByLabel("Synonyms (ingredient text)").fill("x".repeat(81));
  await form.getByRole("button", { name: "Add allergen" }).click();
  await expect(page.locator("#field-key-error")).toContainText("lowercase");
  await expect(page.locator("#field-synonyms-error")).toContainText("at most 80 characters");
  expect(posted).toHaveLength(0);

  // A key another entry holds.
  await page.getByLabel("Key", { exact: true }).fill("milk");
  await page.getByLabel("Name").fill("Milk again");
  await page.getByLabel("Synonyms (ingredient text)").fill("whey");
  await form.getByRole("button", { name: "Add allergen" }).click();
  await expect(page.locator("#field-key-error")).toContainText("already exists");

  // Phrases split on commas and lines, trimmed, and repeats kept once.
  await page.getByLabel("Key", { exact: true }).fill("sesame");
  await page.getByLabel("Name").fill("Sesame");
  await page.getByLabel("Tier").selectOption("both");
  await page
    .getByLabel("Synonyms (ingredient text)")
    .fill("sesame oil, tahini\n  Sesame \nTAHINI\n");
  await page.getByLabel("Description keywords").fill("halva");
  await form.getByRole("button", { name: "Add allergen" }).click();
  await expect(page).toHaveURL(/\/curate\/allergens\/sesame\?added=1$/, { timeout: 30_000 });
  await expect(page.getByTestId("allergen-added")).toContainText("Added to the dictionary");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sesame");
  expect(posted.at(-1)).toEqual({
    key: "sesame",
    displayName: "Sesame",
    tier: "both",
    synonyms: ["sesame oil", "tahini", "Sesame"],
    descriptionKeywords: ["halva"],
    excludePhrases: [],
  });
});

test("Edit: every field but the key is sent, and a re-match that ran out of time is continued", async ({
  page,
}) => {
  await asCurator(page);
  const puts: unknown[] = [];
  await page.route(`**/api/allergens/${GLUTEN_ID}`, (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    const body = route.request().postDataJSON() as Partial<AllergenView>;
    puts.push(body);
    return route.fulfill({
      status: 202,
      json: AllergenWriteResponse.parse({
        allergen: {
          ...DICTIONARY.allergens[0],
          ...body,
          source: "curator",
          rematchPending: true,
        },
        rematch: { done: false, processed: 50, remaining: 20 },
      }),
    });
  });
  await page.route(`**/api/curate/allergens/${GLUTEN_ID}/rematch`, (route) =>
    route.fulfill({ json: { done: true, processed: 20, remaining: 0 } }),
  );

  await page.goto("/curate/allergens/gluten");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Gluten", { timeout: 30_000 });
  await expect(page.getByLabel("Key", { exact: true })).toHaveCount(0); // the key never changes
  await expect(page.getByTestId("allergen-rematch")).toContainText("Re-match unfinished");
  const synonyms = page.getByLabel("Synonyms (ingredient text)");
  await expect(synonyms).toHaveValue("wheat\nbarley\nrye");

  await page.getByLabel("Name").fill("Gluten (wheat, barley, rye)");
  await synonyms.fill("wheat\nbarley\nrye\nspelt");
  await page.getByRole("button", { name: "Save and re-match" }).click();
  await expect(page.getByTestId("allergen-saved")).toContainText("ran out of time");
  expect(puts).toEqual([
    {
      displayName: "Gluten (wheat, barley, rye)",
      tier: "sensitivity",
      synonyms: ["wheat", "barley", "rye", "spelt"],
      descriptionKeywords: ["bread"],
      excludePhrases: ["buckwheat"],
    },
  ]);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Gluten (wheat, barley, rye)");
  const progress = page.getByTestId("allergen-rematch");
  await expect(progress).toContainText("20 foods left to re-match");

  // Typing on while continuing: the finished re-match does not reset the form.
  await page.getByLabel("Exclude phrases").fill("buckwheat\nunsaved");
  await progress.getByRole("button", { name: /Continue re-match/ }).click();
  await expect(progress).toHaveCount(0);
  await expect(page.getByLabel("Exclude phrases")).toHaveValue("buckwheat\nunsaved");
});

test("Delete is refused while members avoid the allergen, then goes through", async ({ page }) => {
  await asCurator(page);
  let avoided = true;
  await page.route(`**/api/allergens/${MILK_ID}`, (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    return avoided
      ? route.fulfill({ status: 409, json: { error: "allergen_avoided", details: { members: 3 } } })
      : route.fulfill({ status: 204 });
  });

  await page.goto("/curate/allergens/milk");
  await page.getByRole("button", { name: "Delete allergen…" }).click({ timeout: 30_000 });
  const confirm = page.getByRole("button", { name: "Delete Milk permanently" });
  await expect(confirm).toBeDisabled();
  await page.getByLabel(/Type the key/).fill("milk");
  await confirm.click();
  await expect(page.getByTestId("delete-error")).toContainText("3 members avoid this allergen");
  await expect(page.getByTestId("delete-error")).toContainText("Nothing was deleted");

  avoided = false;
  await confirm.click();
  await expect(page.getByTestId("allergen-deleted")).toContainText(
    "Milk is no longer in the dictionary",
  );
});

test("an unknown key says so, and a malformed key is a 404", async ({ page }) => {
  await asCurator(page);
  await page.goto("/curate/allergens/no-such-thing");
  await expect(page.getByTestId("allergen-missing")).toContainText("no-such-thing", {
    timeout: 30_000,
  });
  const res = await page.goto("/curate/allergens/Not_A_Key");
  expect(res?.status()).toBe(404);
});

test("the Curator profile on /profile: counters shown, details saved", async ({ page }) => {
  await asCurator(page);
  const puts: unknown[] = [];
  await page.route("**/api/users/me/profiles/curator", (route) => {
    if (route.request().method() !== "PUT") return route.fulfill({ json: CURATOR_PROFILE });
    const body = route.request().postDataJSON() as Partial<CuratorProfileView>;
    puts.push(body);
    return route.fulfill({ json: CuratorProfileView.parse({ ...CURATOR_PROFILE, ...body }) });
  });
  await page.goto("/profile");
  const section = page.getByTestId("curator-profile");
  await expect(section.getByTestId("curator-counters")).toContainText("3 dictionary edits", {
    timeout: 30_000,
  });
  await section.getByLabel("Credentials (optional)").fill("RD");
  await section.getByLabel("Specialties (optional)").fill("dairy,  FODMAP ,");
  await section.getByRole("checkbox", { name: /newest public profiles/ }).check();
  await section.getByRole("button", { name: "Save" }).click();
  await expect(section.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  expect(puts).toEqual([
    { credentials: "RD", bio: null, specialties: ["dairy", "FODMAP"], publicListing: true },
  ]);
  await expect(page.getByTestId("admin-profile")).toHaveCount(0);
});
