import {
  BAND_HIGH,
  BAND_LOW,
  ENERGY,
  MIN_DATA_COVERAGE,
  TRACKED_NUTRIENTS,
  ageBand,
  driRow,
  referenceRow,
  type BandStatus,
  type CalorieMeter,
  type DriRow,
  type NutrientBand,
  type SummaryResponse,
  type TrackedNutrient,
} from "@healtheat/shared";
import type { Types } from "mongoose";
import { HttpError } from "../lib/http.js";
import { Food, LogEntry, MemberProfile, UserAllergen } from "../models/index.js";
import { allergensForFoods } from "./dictionary.js";
import { todayIn } from "./logs.js";

// The weekly summary (T25; design doc, Core algorithms): 7-day coverage bands, today's calorie meter,
// the exposure meter and today's alerts, computed on read from the member's week of LogEntry rows.
//
//   GET /me/summary ─> profile ─> 7 dates ending weekEnding ─> LogEntry {userId,date}
//      └─> Foods (nutrients) ─> allergensForFoods (batched; unstamped foods matched first)
//           ├─> nutrient amounts (canonical id or alternate x factor; missing = unknown, D11)
//           ├─> targets: sex x age DRI row, or the reference row (D9)      ─> bands + dataCoverage
//           ├─> calorieBand | Mifflin-St Jeor x activity +/-10% | null (D4) ─> calorieMeter
//           └─> UserAllergen modes ─> exposure (hits, weight) + today's avoid alerts
//
// Everything below the loader is a pure function, so the unit tests reach every branch without a database.

export type NutrientRow = { nutrientId: number; amountPer100g: number };

/** A food's amount of one nutrient per 100 g, from its canonical id or an alternate; null when unreported. */
export function amountPer100g(nutrients: NutrientRow[], tracked: TrackedNutrient): number | null {
  const direct = nutrients.find((x) => x.nutrientId === tracked.id);
  if (direct) return direct.amountPer100g;
  for (const alt of tracked.alternates) {
    const found = nutrients.find((x) => x.nutrientId === alt.id);
    if (found) return found.amountPer100g * alt.factor;
  }
  return null;
}

type Profile = {
  sex?: string | null;
  birthYear?: number | null;
  heightCm?: number | null;
  weightKg?: number | null;
  activityLevel?: string | null;
  calorieBand?: { low?: number | null; high?: number | null } | null;
  timezone?: string | null;
};

/** Age in whole years in `year`, from the birth year alone (the profile keeps no birth date). */
const ageIn = (birthYear: number, year: number) => year - birthYear;

/** The DRI row for the member: personal when sex and birth year are known, else the reference row (D9). */
export function targetsFor(
  profile: Profile | null,
  today: string,
): { basis: "personal" | "reference"; key: string; row: DriRow } {
  const sex = profile?.sex;
  const birthYear = profile?.birthYear;
  if ((sex === "female" || sex === "male") && typeof birthYear === "number") {
    const band = ageBand(ageIn(birthYear, Number(today.slice(0, 4))));
    return { basis: "personal", key: `${sex}-${band}`, row: driRow(sex, band) };
  }
  return { basis: "reference", key: "reference-adult", row: referenceRow() };
}

const ACTIVITY_FACTORS: Record<string, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

const round10 = (x: number) => Math.round(x / 10) * 10;

/**
 * The member's daily calorie band: their own when set, else Mifflin-St Jeor x activity factor +/-10%;
 * null when neither is possible (no band and sex, birth year, height or weight missing; D4).
 */
export function calorieBandFor(
  profile: Profile | null,
  today: string,
): { low: number; high: number; basis: "set" | "computed" } | null {
  const set = profile?.calorieBand;
  if (typeof set?.low === "number" && typeof set.high === "number")
    return { low: set.low, high: set.high, basis: "set" };
  const sex = profile?.sex;
  const { birthYear, heightCm, weightKg } = profile ?? {};
  if (
    (sex !== "female" && sex !== "male") ||
    typeof birthYear !== "number" ||
    typeof heightCm !== "number" ||
    typeof weightKg !== "number"
  )
    return null;
  const age = ageIn(birthYear, Number(today.slice(0, 4)));
  const bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + (sex === "male" ? 5 : -161);
  const tdee = bmr * (ACTIVITY_FACTORS[profile?.activityLevel ?? "light"] ?? 1.375);
  return { low: round10(tdee * 0.9), high: round10(tdee * 1.1), basis: "computed" };
}

/** Today's calorie meter against a band. */
export function calorieMeter(
  kcal: number,
  band: { low: number; high: number; basis: "set" | "computed" },
): CalorieMeter {
  const status = kcal < band.low ? "under" : kcal > band.high ? "over" : "on";
  return { kcal: Math.round(kcal), low: band.low, high: band.high, status, basis: band.basis };
}

/** The 7 calendar dates (YYYY-MM-DD) ending on `weekEnding`, oldest first. */
export function weekDates(weekEnding: string): string[] {
  const end = Date.parse(`${weekEnding}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, i) =>
    new Date(end - (6 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

export type SummaryEntry = {
  date: string;
  fdcId: number;
  grams: number;
  source: string;
};

/** The band class for an average daily intake against its target and upper line. */
export function bandStatus(intakePerDay: number, target: number, upper: number | null): BandStatus {
  if (intakePerDay < target * BAND_LOW) return "low";
  const high = upper ?? target * BAND_HIGH;
  return intakePerDay > high ? "high" : "ok";
}

/**
 * One band per tracked nutrient over the logged days only (days with no logs count in neither the
 * numerator nor the denominator). A food that does not report the nutrient is unknown for it: its grams
 * count against `dataCoverage`, and below MIN_DATA_COVERAGE the band says "insufficient" (D11).
 */
export function computeBands(
  entries: SummaryEntry[],
  nutrientsOf: Map<number, NutrientRow[]>,
  row: DriRow,
): NutrientBand[] {
  const loggedDays = new Set(entries.map((e) => e.date)).size;
  const totalGrams = entries.reduce((s, e) => s + e.grams, 0);
  return TRACKED_NUTRIENTS.map((t) => {
    const { target, upper } = row[t.key] ?? { target: 0, upper: null };
    let intake = 0;
    let reportedGrams = 0;
    for (const e of entries) {
      const per100 = amountPer100g(nutrientsOf.get(e.fdcId) ?? [], t);
      if (per100 === null) continue;
      intake += (per100 * e.grams) / 100;
      reportedGrams += e.grams;
    }
    const dataCoverage = totalGrams > 0 ? reportedGrams / totalGrams : 0;
    const base = { key: t.key, name: t.name, unit: t.unit, target, upper, dataCoverage };
    if (loggedDays === 0)
      return { ...base, intakePerDay: null, coverage: null, status: "empty" as const };
    if (dataCoverage < MIN_DATA_COVERAGE || target <= 0)
      return { ...base, intakePerDay: null, coverage: null, status: "insufficient" as const };
    const intakePerDay = intake / loggedDays;
    return {
      ...base,
      intakePerDay,
      coverage: intakePerDay / target,
      status: bandStatus(intakePerDay, target, upper),
    };
  });
}

/** Day dots: logged or not, and the share of that day's grams that came from search (not a photo). */
export function computeDays(entries: SummaryEntry[], dates: string[]): SummaryResponse["days"] {
  return dates.map((date) => {
    const day = entries.filter((e) => e.date === date);
    const grams = day.reduce((s, e) => s + e.grams, 0);
    if (day.length === 0) return { date, logged: false, confidence: null };
    const searched = day.filter((e) => e.source === "search").reduce((s, e) => s + e.grams, 0);
    return { date, logged: true, confidence: grams > 0 ? searched / grams : 1 };
  });
}

/** Total kcal of some entries (energy from 1008, or the Atwater ids). */
export function kcalOf(entries: SummaryEntry[], nutrientsOf: Map<number, NutrientRow[]>): number {
  return entries.reduce((s, e) => {
    const per100 = amountPer100g(nutrientsOf.get(e.fdcId) ?? [], ENERGY);
    return s + (per100 === null ? 0 : (per100 * e.grams) / 100);
  }, 0);
}

/**
 * GET /api/users/me/summary: the member's week ending `weekEnding` (default: today in their time zone).
 * A week ending after today is 400 date_in_future, like a log entry's date.
 */
export async function summaryFor(
  userId: Types.ObjectId,
  weekEnding: string | undefined,
  now = new Date(),
): Promise<SummaryResponse> {
  const profile = await MemberProfile.findOne({ userId }).lean();
  const today = todayIn(profile?.timezone ?? "UTC", now);
  const end = weekEnding ?? today;
  if (end > today) throw new HttpError(400, "date_in_future", "weekEnding is after today");
  const dates = weekDates(end);

  const fields = { date: 1, fdcId: 1, grams: 1, source: 1 };
  const entries = (await LogEntry.find(
    { userId, date: { $gte: dates[0], $lte: dates[6] } },
    fields,
  ).lean()) as SummaryEntry[];
  // The calorie meter and the hard alerts always use today (design doc, Core algorithms), whatever
  // week is shown: a past week reads today's entries on their own.
  const todays =
    end === today
      ? entries.filter((e) => e.date === today)
      : ((await LogEntry.find({ userId, date: today }, fields).lean()) as SummaryEntry[]);
  const ids = [...new Set([...entries, ...todays].map((e) => e.fdcId))];
  const foods = ids.length
    ? await Food.find(
        { fdcId: { $in: ids } },
        {
          fdcId: 1,
          description: 1,
          ingredientsText: 1,
          nutrients: 1,
          fetchedAt: 1,
          allergensMatchedAt: 1,
        },
      ).lean()
    : [];
  const nutrientsOf = new Map(foods.map((f) => [f.fdcId, (f.nutrients ?? []) as NutrientRow[]]));
  const descriptionOf = new Map(foods.map((f) => [f.fdcId, f.description]));
  const allergensOf = await allergensForFoods(foods);

  const targets = targetsFor(profile, today);
  const band = calorieBandFor(profile, today);

  const settings = await UserAllergen.find({ userId })
    .populate<{ allergenId: { key: string; displayName: string; tier: string } | null }>(
      "allergenId",
      "key displayName tier",
    )
    .lean();
  const exposure = settings
    .filter((s) => s.mode === "track" && s.allergenId)
    .map((s) => {
      const a = s.allergenId!;
      const hits = entries.filter((e) =>
        (allergensOf.get(e.fdcId) ?? []).some((m) => m.key === a.key),
      );
      const kinds = hits.map(
        (e) => (allergensOf.get(e.fdcId) ?? []).find((m) => m.key === a.key)!.matchKind,
      );
      const threshold = s.weeklyThreshold ?? null;
      return {
        key: a.key,
        displayName: a.displayName,
        tier: a.tier as SummaryResponse["exposure"][number]["tier"],
        hits: hits.length,
        weight: hits.reduce((w, e) => w + e.grams, 0) / 100,
        weeklyThreshold: threshold,
        overThreshold: threshold !== null && hits.length > threshold,
        estimate: kinds.length > 0 && kinds.every((k) => k === "description"),
      };
    });
  const avoided = new Set(
    settings.filter((s) => s.mode === "avoid" && s.allergenId).map((s) => s.allergenId!.key),
  );
  // One alert per avoided allergen and food, however many times the food was logged today.
  const alerts = [...new Set(todays.map((e) => e.fdcId))].flatMap((fdcId) =>
    (allergensOf.get(fdcId) ?? [])
      .filter((m) => avoided.has(m.key))
      .map((m) => ({
        key: m.key,
        displayName: m.displayName,
        fdcId,
        description: descriptionOf.get(fdcId) ?? null,
        matchKind: m.matchKind,
      })),
  );

  const days = computeDays(entries, dates);
  return {
    weekEnding: end,
    today,
    days,
    loggedDays: days.filter((d) => d.logged).length,
    targetBasis: targets.basis,
    driSetKey: targets.key,
    bands: computeBands(entries, nutrientsOf, targets.row),
    calorieMeter: band ? calorieMeter(kcalOf(todays, nutrientsOf), band) : null,
    calorieMeterReason: band ? null : "profile_incomplete",
    exposure,
    alerts,
  };
}
