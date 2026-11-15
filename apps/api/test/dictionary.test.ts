import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { Types } from "mongoose";
import {
  ALLERGEN_SEED,
  AllergenEntry,
  AllergenListResponse,
  FoodDetails,
  type AllergenEntry as Entry,
} from "@healtheat/shared";
import app from "../src/app.js";
import { Allergen, Food, FoodAllergen } from "../src/models/index.js";
import {
  ingredientSegments,
  matchFood,
  normalize,
  type DictionaryEntry,
} from "../src/services/dictionary.js";
import { FOOD_REFRESH_MS } from "../src/services/usda.js";

// T11: the allergen dictionary seed and matcher (design doc: Allergen matching, D12).

const SEED: DictionaryEntry[] = ALLERGEN_SEED.map((a) => ({ ...a, id: new Types.ObjectId() }));
const match = (food: { description: string; ingredientsText?: string | null }, dict = SEED) =>
  Object.fromEntries(matchFood(food, dict).map((m) => [m.entry.key, m]));
const entry = (e: Partial<Entry> & { key: string }): DictionaryEntry => ({
  id: new Types.ObjectId(),
  displayName: e.key,
  tier: "allergy",
  synonyms: [],
  descriptionKeywords: [],
  excludePhrases: [],
  ...e,
});

describe("seed", () => {
  it("is valid, has unique keys and covers the 14 EU-declared allergens plus sensitivities", () => {
    for (const a of ALLERGEN_SEED) AllergenEntry.parse(a);
    const keys = ALLERGEN_SEED.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    const allergies = ALLERGEN_SEED.filter((a) => a.tier !== "sensitivity");
    expect(allergies).toHaveLength(14);
    expect(keys).toEqual(expect.arrayContaining(["histamine", "lactose", "fodmap"]));
    // Every phrase survives normalization (a phrase of only punctuation would never match).
    for (const a of ALLERGEN_SEED)
      for (const p of [...a.synonyms, ...a.descriptionKeywords, ...a.excludePhrases])
        expect(normalize(p), `${a.key}: ${p}`).not.toBe("");
  });
});

describe("normalizer", () => {
  it("lowercases, drops accents and punctuation, and splits ingredients at commas and brackets", () => {
    expect(normalize("  Soy-Lécithine!! ")).toBe("soy lecithine");
    expect(ingredientSegments("Sugar, EMULSIFIER (Soy Lecithin); salt. [whey]")).toEqual([
      "sugar",
      "emulsifier",
      "soy lecithin",
      "salt",
      "whey",
    ]);
    expect(ingredientSegments(" ,() ")).toEqual([]);
  });
});

describe("matcher", () => {
  it('finds "soy lecithin" inside parentheses, reporting the most specific synonym', () => {
    const m = match({
      description: "DARK CHOCOLATE BAR",
      ingredientsText: "COCOA MASS, SUGAR, EMULSIFIER (SOY LECITHIN), VANILLA.",
    });
    expect(m.soy).toMatchObject({ matchKind: "ingredient", matchedSynonym: "soy lecithin" });
  });

  it('matches "parmesan" in the description as histamine-rich with matchKind description, on every data type', () => {
    const foundation = match({ description: "Cheese, parmesan, hard", ingredientsText: null });
    expect(foundation["histamine"]).toMatchObject({
      matchKind: "description",
      matchedSynonym: "parmesan",
    });
    // A branded food with an ingredient list still gets the description match for a sensitivity (D12).
    const branded = match({
      description: "PARMESAN CHEESE",
      ingredientsText: "PASTEURIZED PART-SKIM COW'S MILK, CHEESE CULTURE, SALT, ENZYMES",
    });
    expect(branded["histamine"]).toMatchObject({ matchKind: "description" });
    expect(branded.milk).toMatchObject({ matchKind: "ingredient", matchedSynonym: "milk" });
  });

  it("uses description keywords for allergy-tier entries only when the food has no ingredient text", () => {
    expect(match({ description: "Milk, whole, 3.25% milkfat" }).milk).toMatchObject({
      matchKind: "description",
    });
    // Ingredient text present and free of milk: the name alone is not a milk hit for the allergy tier,
    const bar = match({ description: "MILK CHOCOLATE STYLE BAR", ingredientsText: "SUGAR, COCOA" });
    expect(bar.milk).toBeUndefined();
    // but lactose (a sensitivity) still counts it, as an estimate.
    expect(bar.lactose).toMatchObject({ matchKind: "description", matchedSynonym: "milk" });
    // Blank ingredient text counts as none.
    expect(match({ description: "Eggs, whole, raw", ingredientsText: " , " }).eggs).toBeDefined();
  });

  it("matches whole words only", () => {
    const m = match({
      description: "Stew",
      ingredientsText: "EGGPLANT, MALTODEXTRIN, BUCKWHEAT, SOYBEAN OIL, CRAB APPLE JELLY",
    });
    expect(m.eggs).toBeUndefined();
    expect(m.gluten).toBeUndefined();
    expect(m.crustaceans).toBeUndefined();
    expect(m.soy).toMatchObject({ matchedSynonym: "soybean oil" });
  });

  it("does not count an exclude phrase for its allergen, and still counts it for others", () => {
    const m = match({
      description: "Cookies",
      ingredientsText: "COCOA BUTTER, PEANUT BUTTER, COCONUT MILK, CREAM OF TARTAR",
    });
    expect(m.milk).toBeUndefined();
    expect(m.lactose).toBeUndefined();
    expect(m.peanuts).toMatchObject({ matchedSynonym: "peanut butter" });
    // The same word outside the phrase still matches.
    expect(match({ description: "x", ingredientsText: "COCOA BUTTER, BUTTER" }).milk).toMatchObject(
      { matchedSynonym: "butter" },
    );
  });

  it("never matches a phrase across two ingredients", () => {
    const dict = [entry({ key: "soy-sauce", synonyms: ["soy sauce"] })];
    expect(match({ description: "x", ingredientsText: "SOY, SAUCE" }, dict)).toEqual({});
    expect(match({ description: "x", ingredientsText: "LIGHT SOY SAUCE" }, dict)).toHaveProperty(
      "soy-sauce",
    );
  });

  it("prefers an ingredient match over a description match for the same allergen", () => {
    const m = match({ description: "Parmesan crisps", ingredientsText: "PARMESAN, SALT" });
    expect(m["histamine"]).toMatchObject({ matchKind: "ingredient" });
  });

  it("matches accented and hyphenated label text", () => {
    const m = match({ description: "x", ingredientsText: "Lécithine de SOJA, sesame-seeds" });
    expect(m.soy).toMatchObject({ matchedSynonym: "soja" });
    expect(m.sesame).toMatchObject({ matchedSynonym: "sesame seeds" });
  });
});

// ---- API: the stored dictionary and the matches on GET /api/foods/:fdcId ----

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/usda/${name}.json`, import.meta.url), "utf8"));
const CHEDDAR = fixture("food-branded-cheddar");
const APPLE = fixture("food-foundation-apple");
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const keysOf = (body: FoodDetails) => body.allergens.map((a) => a.key);

describe("GET /api/allergens", () => {
  it("seeds an empty dictionary once and lists it by display name", async () => {
    const [a, b] = await Promise.all([
      request(app).get("/api/allergens").expect(200),
      request(app).get("/api/allergens").expect(200),
    ]);
    const list = AllergenListResponse.parse(a.body).allergens;
    expect(list).toHaveLength(ALLERGEN_SEED.length);
    expect(b.body.allergens).toHaveLength(ALLERGEN_SEED.length);
    expect(await Allergen.countDocuments()).toBe(ALLERGEN_SEED.length);
    expect(list.every((x) => x.source === "seed")).toBe(true);
    const names = list.map((x) => x.displayName);
    expect(names).toEqual([...names].sort((x, y) => x.localeCompare(y, "en")));
  });

  it("never overwrites a stored entry with the seed", async () => {
    await request(app).get("/api/allergens").expect(200);
    await Allergen.updateOne({ key: "milk" }, { $set: { synonyms: ["milk"], source: "curator" } });
    await Allergen.deleteOne({ key: "lupin" });
    const res = await request(app).get("/api/allergens").expect(200);
    const milk = res.body.allergens.find((x: { key: string }) => x.key === "milk");
    expect(milk).toMatchObject({ synonyms: ["milk"], source: "curator" });
    expect(res.body.allergens.some((x: { key: string }) => x.key === "lupin")).toBe(false);
  });
});

describe("allergens on GET /api/foods/:fdcId", () => {
  it("matches a fresh USDA copy, stores its FoodAllergen rows and serves them on the next read", async () => {
    fetchMock.mockImplementation(async () => json(CHEDDAR));
    const res = await request(app).get("/api/foods/2095236").expect(200);
    const body = FoodDetails.parse(res.body);
    expect(keysOf(body)).toEqual(["lactose", "milk"]);
    expect(body.allergens.find((a) => a.key === "milk")).toEqual({
      key: "milk",
      displayName: "Milk",
      tier: "both",
      matchKind: "ingredient",
      matchedSynonym: "milk",
    });
    expect(await FoodAllergen.countDocuments({ fdcId: 2095236 })).toBe(2);
    expect((await Food.findOne({ fdcId: 2095236 }).lean())?.allergensMatchedAt).toBeInstanceOf(
      Date,
    );

    // The next read is served from the stored rows: a dictionary edit since then does not change it
    // until a re-match (T5) or a fresh USDA copy.
    await Allergen.updateOne({ key: "milk" }, { $set: { synonyms: [] } });
    const again = await request(app).get("/api/foods/2095236").expect(200);
    expect(keysOf(again.body)).toEqual(["lactose", "milk"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("matches a food without ingredient text by its description", async () => {
    fetchMock.mockImplementation(async () => json(APPLE));
    const body = FoodDetails.parse((await request(app).get("/api/foods/1750340").expect(200)).body);
    expect(body.allergens).toEqual([
      {
        key: "fodmap",
        displayName: "High-FODMAP foods",
        tier: "sensitivity",
        matchKind: "description",
        matchedSynonym: "apples",
      },
    ]);
  });

  it("matches a stored food that was never matched (cached before T11) without calling USDA", async () => {
    fetchMock.mockImplementation(async () => json(CHEDDAR));
    await request(app).get("/api/foods/2095236").expect(200);
    await FoodAllergen.deleteMany({});
    await Food.updateOne({ fdcId: 2095236 }, { $unset: { allergensMatchedAt: 1 } });
    const res = await request(app).get("/api/foods/2095236").expect(200);
    expect(keysOf(res.body)).toEqual(["lactose", "milk"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await FoodAllergen.countDocuments()).toBe(2);
  });

  it("replaces the rows when a refreshed USDA copy changed its ingredients", async () => {
    fetchMock.mockImplementationOnce(async () => json(CHEDDAR));
    await request(app).get("/api/foods/2095236").expect(200);
    await Food.updateOne(
      { fdcId: 2095236 },
      { $set: { fetchedAt: new Date(Date.now() - FOOD_REFRESH_MS - 1000) } },
    );
    fetchMock.mockImplementationOnce(async () =>
      json({ ...CHEDDAR, ingredients: "PEANUTS, SALT" }),
    );
    const res = await request(app).get("/api/foods/2095236").expect(200);
    expect(keysOf(res.body)).toEqual(["peanuts"]);
    expect(
      (await FoodAllergen.find({ fdcId: 2095236 }).lean()).map((r) => r.matchedSynonym),
    ).toEqual(["peanuts"]);
  });

  it("keeps the allergens on a stored copy served while USDA is down", async () => {
    fetchMock.mockImplementationOnce(async () => json(CHEDDAR));
    await request(app).get("/api/foods/2095236").expect(200);
    await Food.updateOne(
      { fdcId: 2095236 },
      { $set: { fetchedAt: new Date(Date.now() - FOOD_REFRESH_MS - 1000) } },
    );
    fetchMock.mockImplementationOnce(async () => json({}, 503));
    const res = await request(app).get("/api/foods/2095236").expect(200);
    expect(res.body.cached).toBe(true);
    expect(keysOf(res.body)).toEqual(["lactose", "milk"]);
  });

  it("still answers with the matches when storing them fails, and matches again on the next read", async () => {
    fetchMock.mockImplementation(async () => json(CHEDDAR));
    const spy = vi
      .spyOn(FoodAllergen, "bulkWrite")
      .mockRejectedValueOnce(new Error("write failed"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await request(app).get("/api/foods/2095236").expect(200);
    expect(keysOf(res.body)).toEqual(["lactose", "milk"]);
    expect(errors).toHaveBeenCalled();
    expect((await Food.findOne({ fdcId: 2095236 }).lean())?.allergensMatchedAt).toBeNull();
    // Next read: no stamp, so it matches again and this time the rows are stored.
    await request(app).get("/api/foods/2095236").expect(200);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await FoodAllergen.countDocuments()).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not show a row whose allergen was deleted since the match", async () => {
    fetchMock.mockImplementation(async () => json(CHEDDAR));
    await request(app).get("/api/foods/2095236").expect(200);
    await Allergen.deleteOne({ key: "lactose" });
    const res = await request(app).get("/api/foods/2095236").expect(200);
    expect(keysOf(res.body)).toEqual(["milk"]);
  });

  it("indexes FoodAllergen by food and by allergen, one row per pair", async () => {
    await FoodAllergen.syncIndexes();
    const idx = await FoodAllergen.collection.indexes();
    expect(idx).toContainEqual(
      expect.objectContaining({ key: { fdcId: 1, allergenId: 1 }, unique: true }),
    );
    expect(idx).toContainEqual(expect.objectContaining({ key: { allergenId: 1, fdcId: 1 } }));
    await Allergen.syncIndexes();
    expect(await Allergen.collection.indexes()).toContainEqual(
      expect.objectContaining({ key: { key: 1 }, unique: true }),
    );
  });
});
