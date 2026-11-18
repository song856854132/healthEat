import {
  ENERGY,
  GAP_FOODS,
  GAP_KCAL_FLOOR,
  GAP_RESULTS,
  TRACKED_NUTRIENTS,
  type GapFood,
  type GapFoodsResponse,
} from "@healtheat/shared";
import type { Types } from "mongoose";
import { HttpError } from "../lib/http.js";
import { Food, UserAllergen } from "../models/index.js";
import { allergensForFoods, loadDictionary, matchFood } from "./dictionary.js";
import { amountPer100g, type NutrientRow } from "./summary.js";

// Close the gap (T26; design doc, Core algorithms; eng review D3, D8, D12): the best whole-food sources of
// one nutrient per kcal, never a food carrying an allergen the member avoids. Candidates are the shipped
// seed list (no USDA call at request time) plus whole foods already cached.

/** Whole-food data types; branded products (often fortified, near zero kcal) are not candidates (D12). */
const WHOLE_FOOD_TYPES = ["Foundation", "SR Legacy", "Survey (FNDDS)"];

type Candidate = {
  fdcId: number;
  description: string;
  source: GapFood["source"];
  nutrients: NutrientRow[];
  servingGrams: number | null;
};

/** Score, filter and order candidates: amount per kcal, kcal floor, top GAP_RESULTS. Pure. */
export function rankGapFoods(candidates: Candidate[], nutrientId: number): GapFood[] {
  const tracked = TRACKED_NUTRIENTS.find((t) => t.id === nutrientId)!;
  const scored = candidates.flatMap((c) => {
    const amount = amountPer100g(c.nutrients, tracked);
    const kcal = amountPer100g(c.nutrients, ENERGY);
    if (amount === null || amount <= 0 || kcal === null || kcal < GAP_KCAL_FLOOR) return [];
    const portionGrams = c.servingGrams && c.servingGrams > 0 ? c.servingGrams : 100;
    return [
      {
        score: amount / kcal,
        food: {
          fdcId: c.fdcId,
          description: c.description,
          source: c.source,
          amountPer100g: amount,
          kcalPer100g: kcal,
          portionGrams,
          amountPerPortion: (amount * portionGrams) / 100,
        },
      },
    ];
  });
  return scored
    .sort((a, b) => b.score - a.score || a.food.fdcId - b.food.fdcId)
    .slice(0, GAP_RESULTS)
    .map((s) => s.food);
}

/** GET /api/users/me/gaps/:nutrientId/foods. An untracked nutrient id is 404 nutrient_not_tracked. */
export async function gapFoodsFor(
  userId: Types.ObjectId,
  nutrientId: number,
): Promise<GapFoodsResponse> {
  const tracked = TRACKED_NUTRIENTS.find((t) => t.id === nutrientId);
  if (!tracked) throw new HttpError(404, "nutrient_not_tracked");

  const avoid = await UserAllergen.find({ userId, mode: "avoid" }, { allergenId: 1 }).lean();
  const avoidIds = new Set(avoid.map((a) => String(a.allergenId)));
  const dictionary = (await loadDictionary()).filter((e) => avoidIds.has(String(e.id)));

  // Seed foods are never in Food, so they have no stored matches: match them here (D8).
  const seed: Candidate[] = GAP_FOODS.filter(
    (f) =>
      matchFood({ description: f.description, ingredientsText: null }, dictionary).length === 0,
  ).map((f) => ({ ...f, source: "seed" as const, servingGrams: null }));

  // Cached whole foods that report the nutrient, read with only the nutrients the ranking needs (D12).
  const ids = [tracked, ENERGY].flatMap((t) => [t.id, ...t.alternates.map((a) => a.id)]);
  const cached = (await Food.aggregate([
    { $match: { dataType: { $in: WHOLE_FOOD_TYPES }, "nutrients.nutrientId": { $in: ids } } },
    {
      $project: {
        fdcId: 1,
        description: 1,
        ingredientsText: 1,
        fetchedAt: 1,
        allergensMatchedAt: 1,
        servingSizes: { $slice: ["$servingSizes", 1] },
        nutrients: {
          $filter: { input: "$nutrients", as: "n", cond: { $in: ["$$n.nutrientId", ids] } },
        },
      },
    },
  ])) as {
    fdcId: number;
    description: string;
    ingredientsText?: string | null;
    fetchedAt: Date;
    allergensMatchedAt?: Date | null;
    servingSizes?: { grams: number }[];
    nutrients: NutrientRow[];
  }[];
  // Unstamped cached foods are matched first, so a stale copy cannot slip an avoided allergen through.
  const allergensOf = avoidIds.size > 0 ? await allergensForFoods(cached) : new Map();
  const avoidKeys = new Set(dictionary.map((e) => e.key));
  const safeCached: Candidate[] = cached
    .filter(
      (f) => !(allergensOf.get(f.fdcId) ?? []).some((m: { key: string }) => avoidKeys.has(m.key)),
    )
    .map((f) => ({
      fdcId: f.fdcId,
      description: f.description,
      source: "cache" as const,
      nutrients: f.nutrients,
      servingGrams: f.servingSizes?.[0]?.grams ?? null,
    }));

  const cachedIds = new Set(safeCached.map((c) => c.fdcId));
  const candidates = [...safeCached, ...seed.filter((s) => !cachedIds.has(s.fdcId))];
  return {
    nutrient: { id: tracked.id, key: tracked.key, name: tracked.name, unit: tracked.unit },
    foods: rankGapFoods(candidates, nutrientId),
  };
}
