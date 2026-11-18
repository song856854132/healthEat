import { z } from "zod";
import { ALLERGEN_TIERS, MATCH_KINDS } from "./allergens.js";

// The weekly summary (T25; design doc, Core algorithms): 7-day coverage bands, today's calorie meter,
// the exposure meter and today's alerts. The thresholds and the tracked nutrients live here so the API
// and the web app classify and label bands from one copy (eng review 2026-11-18, D11).

/** Coverage below this share of the target is "low". */
export const BAND_LOW = 0.7;
/** Coverage above this share of the target is "high" when the nutrient has no upper line. */
export const BAND_HIGH = 1.3;
/** A band needs at least this share of the week's logged grams to report the nutrient (D11). */
export const MIN_DATA_COVERAGE = 0.5;

export const BAND_STATUSES = ["low", "ok", "high", "insufficient", "empty"] as const;
export type BandStatus = (typeof BAND_STATUSES)[number];

/**
 * A nutrient the summary tracks: the USDA FoodData Central id it is read from, and alternate ids with the
 * factor that converts their amounts into this unit (vitamin D in IU: 1 IU = 0.025 µg). Vitamin A in IU
 * is not converted: the IU-to-RAE factor depends on the source (retinol or carotenoids).
 */
export type TrackedNutrient = {
  key: string;
  name: string;
  unit: "g" | "mg" | "µg" | "kcal";
  id: number;
  alternates: { id: number; factor: number }[];
};

/** Energy: 1008, or the Atwater ids 2047/2048 that Foundation foods use instead (usda.ts). */
export const ENERGY: TrackedNutrient = {
  key: "energy",
  name: "Energy",
  unit: "kcal",
  id: 1008,
  alternates: [
    { id: 2047, factor: 1 },
    { id: 2048, factor: 1 },
  ],
};

const n = (
  key: string,
  name: string,
  unit: TrackedNutrient["unit"],
  id: number,
  alternates: TrackedNutrient["alternates"] = [],
): TrackedNutrient => ({ key, name, unit, id, alternates });

/** The nutrients a member's bands show, in display order. */
export const TRACKED_NUTRIENTS: readonly TrackedNutrient[] = [
  n("protein", "Protein", "g", 1003),
  n("fiber", "Fiber", "g", 1079),
  n("vitaminA", "Vitamin A", "µg", 1106),
  n("vitaminC", "Vitamin C", "mg", 1162),
  n("vitaminD", "Vitamin D", "µg", 1114, [{ id: 1110, factor: 0.025 }]),
  n("vitaminE", "Vitamin E", "mg", 1109),
  n("vitaminK", "Vitamin K", "µg", 1185),
  n("thiamin", "Thiamin", "mg", 1165),
  n("riboflavin", "Riboflavin", "mg", 1166),
  n("niacin", "Niacin", "mg", 1167),
  n("vitaminB6", "Vitamin B6", "mg", 1175),
  n("folate", "Folate", "µg", 1190, [{ id: 1177, factor: 1 }]),
  n("vitaminB12", "Vitamin B12", "µg", 1178),
  n("calcium", "Calcium", "mg", 1087),
  n("iron", "Iron", "mg", 1089),
  n("magnesium", "Magnesium", "mg", 1090),
  n("potassium", "Potassium", "mg", 1092),
  n("sodium", "Sodium", "mg", 1093),
  n("zinc", "Zinc", "mg", 1095),
];

/** The tracked nutrient with this USDA id (canonical or alternate), if any. */
export function trackedById(id: number): TrackedNutrient | undefined {
  return [ENERGY, ...TRACKED_NUTRIENTS].find(
    (t) => t.id === id || t.alternates.some((a) => a.id === id),
  );
}

/** Query of GET /api/users/me/summary: the last date of the 7-day window; today when absent. */
export const SummaryQuery = z.object({
  weekEnding: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD")
    // Date.parse rolls 2026-02-31 over to March, so the date must survive a round trip.
    .refine((d) => {
      const t = Date.parse(`${d}T00:00:00Z`);
      return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
    }, "not a calendar date")
    .optional(),
});
export type SummaryQuery = z.infer<typeof SummaryQuery>;

export const NutrientBand = z.object({
  key: z.string(),
  name: z.string(),
  unit: z.string(),
  /** Daily target (RDA or AI) for the member's DRI row, or the reference row. */
  target: z.number(),
  /** Daily upper line: the UL where one is defined (the CDRR for sodium), else null. */
  upper: z.number().nullable(),
  /** Average daily intake over the logged days; null when the band is empty or lacks data. */
  intakePerDay: z.number().nullable(),
  /** intakePerDay / target; null when the band is empty or lacks data. */
  coverage: z.number().nullable(),
  /** Share of the week's logged grams whose food reports this nutrient (0 to 1). */
  dataCoverage: z.number(),
  status: z.enum(BAND_STATUSES),
});
export type NutrientBand = z.infer<typeof NutrientBand>;

export const SummaryDay = z.object({
  date: z.string(),
  logged: z.boolean(),
  /** Grams logged from search / all grams logged that day (1 = all searched); null when unlogged. */
  confidence: z.number().nullable(),
});

export const CalorieMeter = z.object({
  kcal: z.number(),
  low: z.number(),
  high: z.number(),
  status: z.enum(["under", "on", "over"]),
  /** "set": the member's own calorieBand; "computed": Mifflin-St Jeor x activity, plus or minus 10%. */
  basis: z.enum(["set", "computed"]),
});
export type CalorieMeter = z.infer<typeof CalorieMeter>;

export const ExposureRow = z.object({
  key: z.string(),
  displayName: z.string(),
  tier: z.enum(ALLERGEN_TIERS),
  /** Logged entries this week whose food matched the allergen. */
  hits: z.number().int(),
  /** Grams of those entries / 100 (the secondary figure in the design doc). */
  weight: z.number(),
  weeklyThreshold: z.number().nullable(),
  overThreshold: z.boolean(),
  /** Every hit came from a description match: a food-category estimate, not an ingredient. */
  estimate: z.boolean(),
});

export const SummaryAlert = z.object({
  key: z.string(),
  displayName: z.string(),
  fdcId: z.number().int(),
  description: z.string().nullable(),
  matchKind: z.enum(MATCH_KINDS),
});

/** Response of GET /api/users/me/summary. */
export const SummaryResponse = z.object({
  weekEnding: z.string(),
  today: z.string(),
  days: z.array(SummaryDay).length(7),
  loggedDays: z.number().int().min(0).max(7),
  /** "personal": the member's sex and age row; "reference": the adult reference row (D9). */
  targetBasis: z.enum(["personal", "reference"]),
  /** The DRI row the targets came from, derived from sex and age (e.g. "female-31-50"). */
  driSetKey: z.string(),
  bands: z.array(NutrientBand),
  calorieMeter: CalorieMeter.nullable(),
  /** Why calorieMeter is null: no band set and sex, birthYear, height or weight missing (D4). */
  calorieMeterReason: z.literal("profile_incomplete").nullable(),
  exposure: z.array(ExposureRow),
  alerts: z.array(SummaryAlert),
});
export type SummaryResponse = z.infer<typeof SummaryResponse>;
