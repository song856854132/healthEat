import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { makeAccount } from "./helpers";
import type { UserAllergenView } from "../packages/shared/src/index";
import { DICTIONARY, MEMBER_PROFILE, mockSession } from "./role-mocks";

// Lane B (T31): the member's settings on /profile, against the real stack. Allergens to avoid or track
// (GET/PUT /api/users/me/allergens) and body details, calorie band and time zone (PUT
// /api/users/me/profiles/member), and what Member Home makes of them. The allergen keys are from the
// project's seed (packages/shared/src/allergens.seed.ts), which every new database reads first.

async function signUp(page: Page, prefix: string) {
  // page.request shares the tab's cookies: this signs the tab in.
  const res = await page.request.post("/api/auth/register", { data: makeAccount(prefix) });
  expect(res.status(), await res.text()).toBe(201);
}

/** Counts the PUTs this page sends to one API path, to show validation stops a request. */
function countPuts(page: Page, path: string): () => number {
  let n = 0;
  page.on("request", (r) => {
    if (r.method() === "PUT" && new URL(r.url()).pathname === path) n += 1;
  });
  return () => n;
}

test("Home's prompts lead a new member to the settings", async ({ page }) => {
  await signUp(page, "st");
  await page.goto("/");
  await expect(page.getByTestId("calorie-incomplete").getByRole("link")).toHaveAttribute(
    "href",
    "/profile#body",
    { timeout: 30_000 },
  );
  await page.getByTestId("exposure-empty").getByRole("link").click();
  await expect(page).toHaveURL(/\/profile#allergens$/, { timeout: 30_000 });
  await expect(page.getByTestId("allergen-settings")).toBeVisible();
});

test("allergens: avoid one and track one with a threshold; saved, reloaded, and on Home", async ({
  page,
}) => {
  await signUp(page, "sa");
  const puts = countPuts(page, "/api/users/me/allergens");
  await page.goto("/profile#allergens");
  const section = page.getByTestId("allergen-settings");
  const peanuts = section.getByRole("combobox", { name: "Your choice for Peanuts" });
  await expect(peanuts).toHaveValue("", { timeout: 30_000 });
  await expect(section.getByTestId("allergen-counts")).toHaveText("Avoiding 0 · tracking 0");

  await peanuts.selectOption("avoid");
  await section.getByRole("combobox", { name: "Your choice for Lactose" }).selectOption("track");
  const threshold = section.getByRole("spinbutton", { name: "Weekly threshold for Lactose" });
  // Only Track rows take a threshold.
  await expect(section.getByRole("spinbutton")).toHaveCount(1);
  await threshold.fill("0");
  await section.getByRole("button", { name: "Save allergens" }).click();
  await expect(section.locator("#threshold-lactose-error")).toContainText("whole number from 1");
  expect(puts()).toBe(0);

  await threshold.fill("5");
  await section.getByRole("button", { name: "Save allergens" }).click();
  await expect(section.getByRole("status").filter({ hasText: "Saved." })).toBeVisible({
    timeout: 30_000,
  });
  await expect(section.getByTestId("allergen-counts")).toHaveText("Avoiding 1 · tracking 1");
  const stored = await page.request.get("/api/users/me/allergens");
  expect((await stored.json()) as unknown).toEqual({
    allergens: [
      { key: "lactose", displayName: "Lactose", mode: "track", weeklyThreshold: 5 },
      { key: "peanuts", displayName: "Peanuts", mode: "avoid", weeklyThreshold: null },
    ],
  });

  await page.reload();
  await expect(page.getByRole("combobox", { name: "Your choice for Peanuts" })).toHaveValue(
    "avoid",
    { timeout: 30_000 },
  );
  await expect(page.getByRole("spinbutton", { name: "Weekly threshold for Lactose" })).toHaveValue(
    "5",
  );

  // Home's exposure meter now lists the tracked sensitivity instead of the prompt.
  await page.goto("/");
  await expect(page.getByTestId("exposure-row").filter({ hasText: "Lactose" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("exposure-empty")).toHaveCount(0);

  // Not set again: the complete list replaces the stored one.
  await page.goto("/profile#allergens");
  await page.getByRole("combobox", { name: "Your choice for Lactose" }).selectOption("");
  await page.getByRole("button", { name: "Save allergens" }).click();
  await expect(
    page.getByTestId("allergen-settings").getByRole("status").filter({ hasText: "Saved." }),
  ).toBeVisible({ timeout: 30_000 });
  const after = await page.request.get("/api/users/me/allergens");
  expect(
    ((await after.json()) as { allergens: { key: string }[] }).allergens.map((a) => a.key),
  ).toEqual(["peanuts"]);
});

test("body details: checked before sending, then Home's calorie meter replaces the prompt", async ({
  page,
}) => {
  await signUp(page, "sb");
  const puts = countPuts(page, "/api/users/me/profiles/member");
  await page.goto("/profile#body");
  const form = page.getByTestId("body-form");
  await expect(form.getByTestId("meter-basis")).toContainText("choose female or male", {
    timeout: 30_000,
  });

  await form.getByLabel("Birth year").fill("1800");
  await form.getByLabel("Height (cm)").fill("10");
  await form.getByLabel("Your own calorie band: from (kcal)").fill("1800");
  await form.getByRole("button", { name: "Save details" }).click();
  await expect(page.locator("#field-birthYear-error")).toContainText("A year from 1900");
  await expect(page.locator("#field-heightCm-error")).toContainText("From 50 to 272 cm");
  await expect(page.locator("#field-bandHigh-error")).toContainText("Set both ends");
  expect(puts()).toBe(0);

  await form.getByLabel("Sex").selectOption("female");
  await form.getByLabel("Birth year").fill("1990");
  await form.getByLabel("Height (cm)").fill("165");
  await form.getByLabel("Weight (kg)").fill("60");
  await form.getByLabel("Activity level").selectOption("moderate");
  await form.getByLabel("Your own calorie band: from (kcal)").fill("");
  await form.getByRole("button", { name: "Save details" }).click();
  await expect(form.getByRole("status").filter({ hasText: "Saved." })).toBeVisible({
    timeout: 30_000,
  });
  await expect(form.getByTestId("meter-basis")).toContainText("computed from these details");

  await page.goto("/");
  const meter = page.getByTestId("calorie-meter");
  await expect(meter).toContainText("estimated from your profile", { timeout: 30_000 });
  await expect(page.getByTestId("calorie-incomplete")).toHaveCount(0);
  await expect(page.getByTestId("target-basis")).toContainText("Targets for your sex and age band");

  // An own band wins over the computed one; low above high is refused; clearing both goes back.
  await page.goto("/profile#body");
  const low = page.getByLabel("Your own calorie band: from (kcal)");
  const high = page.getByLabel("to (kcal)");
  await low.fill("2200");
  await high.fill("1800");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.locator("#field-bandLow-error")).toContainText("must not be above");
  await low.fill("1800");
  await high.fill("2000");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByTestId("meter-basis")).toContainText(
    "your own band: 1,800 to 2,000 kcal",
    {
      timeout: 30_000,
    },
  );
  await page.goto("/");
  await expect(page.getByTestId("calorie-meter")).toContainText(
    "1,800 to 2,000 kcal, your own band",
    {
      timeout: 30_000,
    },
  );

  await page.goto("/profile#body");
  await page.getByLabel("Your own calorie band: from (kcal)").fill("");
  await page.getByLabel("to (kcal)").fill("");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByTestId("meter-basis")).toContainText("computed from these details", {
    timeout: 30_000,
  });
  // The sharing choices were left as they were: the body PUT sends only its own fields.
  const profile = await page.request.get("/api/users/me/profiles/member");
  expect(await profile.json()).toMatchObject({
    sex: "female",
    birthYear: 1990,
    heightCm: 165,
    weightKg: 60,
    activityLevel: "moderate",
    calorieBand: null,
    publicLogs: false,
  });
});

test.describe("time zone", () => {
  test.use({ timezoneId: "America/New_York" });

  test("an unknown zone is refused, and the browser's zone is one click away", async ({ page }) => {
    await signUp(page, "sz"); // registered with UTC (e2e/helpers.ts)
    await page.goto("/profile#body");
    const zone = page.getByLabel("Time zone");
    await expect(zone).toHaveValue("UTC", { timeout: 30_000 });
    await zone.fill("Mars/Olympus_Mons");
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.locator("#field-timezone-error")).toContainText("Not a time zone");

    await page
      .getByRole("button", { name: "Use this browser’s time zone (America/New_York)" })
      .click();
    await expect(zone).toHaveValue("America/New_York");
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(
      page.getByTestId("body-form").getByRole("status").filter({ hasText: "Saved." }),
    ).toBeVisible({ timeout: 30_000 });
    const profile = await page.request.get("/api/users/me/profiles/member");
    expect(((await profile.json()) as { timezone: string }).timezone).toBe("America/New_York");
  });
});

test("a number the browser cannot read is refused, never saved as a cleared value", async ({
  page,
}) => {
  await signUp(page, "sn");
  const allergenPuts = countPuts(page, "/api/users/me/allergens");
  await page.goto("/profile#body");
  const form = page.getByTestId("body-form");
  const weight = form.getByLabel("Weight (kg)");
  await weight.fill("60", { timeout: 30_000 });
  await form.getByRole("button", { name: "Save details" }).click();
  await expect(form.getByRole("status").filter({ hasText: "Saved." })).toBeVisible({
    timeout: 30_000,
  });

  // "6e" is not a number: the input reports "" for it, which must not clear the stored weight.
  await weight.clear();
  await weight.pressSequentially("6e");
  await form.getByRole("button", { name: "Save details" }).click();
  await expect(page.locator("#field-weightKg-error")).toContainText("Enter a number");
  const profile = await page.request.get("/api/users/me/profiles/member");
  expect(((await profile.json()) as { weightKg: number | null }).weightKg).toBe(60);

  // The same for a weekly threshold: it is refused, not saved as "no threshold".
  const section = page.getByTestId("allergen-settings");
  await section.getByRole("combobox", { name: "Your choice for Lactose" }).selectOption("track");
  await section
    .getByRole("spinbutton", { name: "Weekly threshold for Lactose" })
    .pressSequentially("5e");
  await section.getByRole("button", { name: "Save allergens" }).click();
  await expect(section.locator("#threshold-lactose-error")).toContainText("whole number");
  expect(allergenPuts()).toBe(0);
});

test("a stale tab never drops an allergen saved elsewhere", async ({ page }) => {
  await signUp(page, "ss");
  await page.goto("/profile#allergens");
  const section = page.getByTestId("allergen-settings");
  const peanuts = section.getByRole("combobox", { name: "Your choice for Peanuts" });
  await expect(peanuts).toHaveValue("", { timeout: 30_000 });

  // Another tab or device avoids peanuts after this page loaded.
  const elsewhere = await page.request.put("/api/users/me/allergens", {
    data: { allergens: [{ key: "peanuts", mode: "avoid" }] },
  });
  expect(elsewhere.ok()).toBe(true);

  await section.getByRole("combobox", { name: "Your choice for Lactose" }).selectOption("track");
  await section.getByRole("button", { name: "Save allergens" }).click();
  await expect(section.getByRole("alert")).toContainText("changed in another tab");
  const stored = await page.request.get("/api/users/me/allergens");
  expect(
    ((await stored.json()) as { allergens: { key: string }[] }).allergens.map((a) => a.key),
  ).toEqual(["peanuts"]);
  // The form now shows the list as stored.
  await expect(peanuts).toHaveValue("avoid");
});

test("Save details sends only what changed, so a time zone set elsewhere stays", async ({
  page,
}) => {
  await signUp(page, "sd");
  await page.goto("/profile#body");
  const form = page.getByTestId("body-form");
  await expect(form.getByLabel("Time zone")).toHaveValue("UTC", { timeout: 30_000 });

  // Another device moves the member to Paris after this page loaded.
  const elsewhere = await page.request.put("/api/users/me/profiles/member", {
    data: { timezone: "Europe/Paris" },
  });
  expect(elsewhere.ok()).toBe(true);

  await form.getByLabel("Weight (kg)").fill("70");
  await form.getByRole("button", { name: "Save details" }).click();
  await expect(form.getByRole("status").filter({ hasText: "Saved." })).toBeVisible({
    timeout: 30_000,
  });
  const profile = await page.request.get("/api/users/me/profiles/member");
  expect(await profile.json()).toMatchObject({ weightKg: 70, timezone: "Europe/Paris" });

  // Saving again with nothing changed sends nothing, and says so rather than "Saved.".
  await form.getByRole("button", { name: "Save details" }).click();
  await expect(form.getByRole("status")).toHaveText("No changes to save.");
});

test("an unreadable number typed into an emptied field is refused too, and clearing it lifts the error", async ({
  page,
}) => {
  await signUp(page, "sc");
  const allergenPuts = countPuts(page, "/api/users/me/allergens");
  await page.goto("/profile#body");
  const form = page.getByTestId("body-form");
  const weight = form.getByLabel("Weight (kg)");
  await weight.fill("60", { timeout: 30_000 });
  await form.getByRole("button", { name: "Save details" }).click();
  await expect(form.getByRole("status").filter({ hasText: "Saved." })).toBeVisible({
    timeout: 30_000,
  });

  // Emptied, then "-": the field's value stays "" throughout, so React sends no change for it.
  await weight.clear();
  await weight.pressSequentially("-");
  await form.getByRole("button", { name: "Save details" }).click();
  await expect(page.locator("#field-weightKg-error")).toContainText("Enter a number");
  let profile = await page.request.get("/api/users/me/profiles/member");
  expect(((await profile.json()) as { weightKg: number | null }).weightKg).toBe(60);

  // Deleting the unreadable text and typing a number saves it: the refusal does not stick.
  await weight.press("Backspace");
  await weight.pressSequentially("61");
  await form.getByRole("button", { name: "Save details" }).click();
  await expect(form.getByRole("status").filter({ hasText: "Saved." })).toBeVisible({
    timeout: 30_000,
  });
  profile = await page.request.get("/api/users/me/profiles/member");
  expect(((await profile.json()) as { weightKg: number | null }).weightKg).toBe(61);

  // A threshold box starts empty: an unreadable first key is refused, not saved as no threshold.
  const section = page.getByTestId("allergen-settings");
  await section.getByRole("combobox", { name: "Your choice for Lactose" }).selectOption("track");
  await section
    .getByRole("spinbutton", { name: "Weekly threshold for Lactose" })
    .pressSequentially("e");
  await section.getByRole("button", { name: "Save allergens" }).click();
  await expect(section.locator("#threshold-lactose-error")).toContainText("whole number");
  expect(allergenPuts()).toBe(0);
});

test("a stale refresh keeps an allergen this page does not list, so the next save keeps it", async ({
  page,
}) => {
  await mockSession(page, { username: "mock_member", roles: ["member"], activeRole: "member" });
  await page.route("**/api/allergens", (route) => route.fulfill({ json: DICTIONARY }));
  let stored: UserAllergenView[] = [];
  const puts: unknown[] = [];
  await page.route("**/api/users/me/allergens", (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as {
        allergens: { key: string; mode: "avoid" | "track"; weeklyThreshold?: number }[];
      };
      puts.push(body);
      stored = body.allergens.map((a) => ({
        key: a.key,
        displayName: a.key,
        mode: a.mode,
        weeklyThreshold: a.weeklyThreshold ?? null,
      }));
    }
    return route.fulfill({ json: { allergens: stored } });
  });

  await page.goto("/profile");
  const section = page.getByTestId("allergen-settings");
  const milk = section.getByRole("combobox", { name: "Your choice for Milk" });
  await expect(milk).toHaveValue("", { timeout: 30_000 });
  // After this page loaded, a Curator added Sesame and another device avoids it.
  stored = [{ key: "sesame", displayName: "Sesame", mode: "avoid", weeklyThreshold: null }];
  await milk.selectOption("avoid");
  await section.getByRole("button", { name: "Save allergens" }).click();
  await expect(section.getByRole("alert")).toContainText("changed in another tab");
  await milk.selectOption("avoid");
  await section.getByRole("button", { name: "Save allergens" }).click();
  await expect(section.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  expect(puts).toEqual([
    {
      allergens: [
        { key: "milk", mode: "avoid" },
        { key: "sesame", mode: "avoid" },
      ],
    },
  ]);
});

test("a link to /profile#allergens opens at the allergen section, even on a full page load", async ({
  page,
}) => {
  await signUp(page, "sh");
  await page.goto("/profile#allergens");
  await expect(page.getByTestId("allergen-settings-form")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("body-form")).toBeVisible();
  await expect(page.locator("#allergens-heading")).toBeInViewport();
});

test("the new sections never save to an account another tab signed in to, and a vanished allergen is explained", async ({
  page,
}) => {
  const session = await mockSession(page, {
    username: "mock_member",
    roles: ["member"],
    activeRole: "member",
  });
  const puts: string[] = [];
  await page.route("**/api/users/me/allergens", (route) => {
    if (route.request().method() !== "PUT") return route.fulfill({ json: { allergens: [] } });
    puts.push("allergens");
    return route.fulfill({
      status: 400,
      json: { error: "unknown_allergen", details: { keys: ["peanuts"] } },
    });
  });
  await page.route("**/api/users/me/profiles/member", (route) => {
    if (route.request().method() === "PUT") puts.push("member");
    return route.fulfill({ json: MEMBER_PROFILE });
  });

  await page.goto("/profile");
  const section = page.getByTestId("allergen-settings");
  await section
    .getByRole("combobox", { name: "Your choice for Peanuts" })
    .selectOption("avoid", { timeout: 30_000 });
  await section.getByRole("button", { name: "Save allergens" }).click();
  await expect(section.getByRole("alert")).toContainText("(peanuts)");
  await expect(section.getByRole("alert")).toContainText("Nothing was saved");
  expect(puts).toEqual(["allergens"]);

  // Another tab logs in as someone else: neither new section writes to that account.
  session.username = "other_member";
  await page.getByTestId("body-form").getByLabel("Weight (kg)").fill("70");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByTestId("nav-username")).toHaveText("other_member", { timeout: 30_000 });
  expect(puts).toEqual(["allergens"]);
});
