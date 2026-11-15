import { describe, expect, it } from "vitest";
import {
  ALLERGEN_SEED,
  AllergenEntry,
  AllergenKey,
  FOOD_CATEGORY_ESTIMATE_LABEL,
  FoodAllergenMatch,
  FoodDetails,
} from "./index.js";

describe("allergen schemas (T11)", () => {
  it("accepts URL-safe keys only", () => {
    expect(AllergenKey.safeParse("tree-nuts").success).toBe(true);
    for (const bad of ["Tree nuts", "tree--nuts", "-milk", "milk-", ""])
      expect(AllergenKey.safeParse(bad).success, bad).toBe(false);
  });

  it("trims phrases and refuses empty ones", () => {
    const base = {
      key: "x",
      displayName: "X",
      tier: "allergy",
      descriptionKeywords: [],
      excludePhrases: [],
    };
    expect(AllergenEntry.parse({ ...base, synonyms: [" soy "] }).synonyms).toEqual(["soy"]);
    expect(AllergenEntry.safeParse({ ...base, synonyms: ["  "] }).success).toBe(false);
    expect(AllergenEntry.safeParse({ ...base, tier: "mild", synonyms: [] }).success).toBe(false);
  });

  it("ships a seed that parses, and the estimate label", () => {
    expect(ALLERGEN_SEED.length).toBeGreaterThan(0);
    for (const a of ALLERGEN_SEED) AllergenEntry.parse(a);
    expect(FOOD_CATEGORY_ESTIMATE_LABEL).toBe("food-category estimate");
  });

  it("requires allergens on food details", () => {
    const details = {
      fdcId: 1,
      description: "x",
      dataType: "Branded",
      brandOwner: null,
      ingredientsText: null,
      nutrients: [],
      servingSizes: [],
      cached: false,
      fetchedAt: new Date().toISOString(),
    };
    expect(FoodDetails.safeParse(details).success).toBe(false);
    const match = {
      key: "soy",
      displayName: "Soy",
      tier: "both",
      matchKind: "ingredient",
      matchedSynonym: "soy",
    };
    expect(FoodAllergenMatch.parse(match)).toEqual(match);
    expect(FoodDetails.parse({ ...details, allergens: [match] }).allergens).toHaveLength(1);
  });
});
