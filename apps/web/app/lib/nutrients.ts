import type { FoodNutrient } from "@healtheat/shared";

// USDA nutrient ids (FoodData Central nutrient table). Energy comes as 1008 (kcal) for most data
// types, and as the Atwater values 2047/2048 for Foundation foods; the API keeps the same set for
// result rows (apps/api/src/services/usda.ts, HEADLINE_NUTRIENTS).
const ENERGY_IDS = [1008, 2047, 2048];
const PROTEIN = 1003;
const FAT = 1004;
const CARBS = 1005;

const kcal = (n: FoodNutrient) => n.unit.toLowerCase() === "kcal";

/** The four numbers a result row shows. Energy prefers kcal, in the order of ENERGY_IDS. */
export function headline(nutrients: readonly FoodNutrient[]) {
  const byId = (id: number) => nutrients.find((n) => n.nutrientId === id);
  const energy = ENERGY_IDS.map((id) => nutrients.find((n) => n.nutrientId === id && kcal(n))).find(
    Boolean,
  );
  return { energy, protein: byId(PROTEIN), fat: byId(FAT), carbs: byId(CARBS) };
}

/** Energy, protein, fat and carbs first (as on a result row), then the rest in USDA's order. */
export function headlineFirst(nutrients: readonly FoodNutrient[]): FoodNutrient[] {
  const h = headline(nutrients);
  const top = [h.energy, h.protein, h.fat, h.carbs].filter((n): n is FoodNutrient => !!n);
  return [...top, ...nutrients.filter((n) => !top.includes(n))];
}

/** 0.0123 -> "0.012", 12.345 -> "12.3", 1234.5 -> "1,235": about three significant figures. */
export function formatAmount(value: number): string {
  const abs = Math.abs(value);
  const digits = abs === 0 || abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
  return value.toLocaleString("en-US", { maximumFractionDigits: digits });
}

/** Amount in `grams` of a food from its per-100 g value. */
export function scaled(per100g: number, grams: number): number {
  return (per100g * grams) / 100;
}
