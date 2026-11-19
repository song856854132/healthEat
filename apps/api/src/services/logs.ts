import {
  MEALS,
  type AllergenAlert,
  type AllergenMode,
  type AllergenTier,
  type LogEntryCreateInput,
  type LogEntryCreated,
  type LogEntryUpdateInput,
  type LogEntryView,
  type LogListResponse,
  type LogsQuery,
  type UserAllergenView,
  type UserAllergensInput,
} from "@healtheat/shared";
import type { Types } from "mongoose";
import { HttpError } from "../lib/http.js";
import { Allergen, Food, LogEntry, MemberProfile, UserAllergen } from "../models/index.js";
import { loadDictionary } from "./dictionary.js";
import { getFood } from "./usda.js";
import type { LogEntryDoc } from "../models/LogEntry.js";

// Day logs and allergen settings of the signed-in member (design doc: REST table, A2, R3-25 to R3-27).
// Every function takes the caller's own user id: there is no route that names another member.

/** The calendar date (YYYY-MM-DD) it is now in `timeZone`; an unknown zone falls back to UTC. */
export function todayIn(timeZone: string, now = new Date()): string {
  const format = (tz: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  try {
    return format(timeZone);
  } catch {
    return format("UTC");
  }
}

export async function memberToday(userId: Types.ObjectId, now: Date): Promise<string> {
  const profile = await MemberProfile.findOne({ userId }, { timezone: 1 }).lean();
  return todayIn(profile?.timezone ?? "UTC", now);
}

type EntryDoc = {
  _id: Types.ObjectId;
  date: string;
  meal: string;
  fdcId: number;
  grams: number;
  source: string;
  confidence: number;
  createdAt: Date;
};

async function views(entries: EntryDoc[]): Promise<LogEntryView[]> {
  const ids = [...new Set(entries.map((e) => e.fdcId))];
  const foods = ids.length
    ? await Food.find({ fdcId: { $in: ids } }, { fdcId: 1, description: 1 }).lean()
    : [];
  const names = new Map(foods.map((f) => [f.fdcId, f.description]));
  return entries.map((e) => ({
    id: String(e._id),
    date: e.date,
    meal: e.meal as LogEntryView["meal"],
    fdcId: e.fdcId,
    description: names.get(e.fdcId) ?? null,
    grams: e.grams,
    source: e.source as LogEntryView["source"],
    confidence: e.confidence,
    createdAt: e.createdAt.toISOString(),
  }));
}

const mealOrder = (m: string) => MEALS.indexOf(m as (typeof MEALS)[number]);

/** GET /api/users/me/logs: entries from `from` to `to` (inclusive); no bounds means today. */
export async function listLogs(
  userId: Types.ObjectId,
  q: LogsQuery,
  now = new Date(),
): Promise<LogListResponse> {
  const today = q.from && q.to ? null : await memberToday(userId, now);
  const from = q.from ?? q.to ?? today!;
  const to = q.to ?? q.from ?? today!;
  const entries = (await LogEntry.find({
    userId,
    date: { $gte: from, $lte: to },
  }).lean()) as EntryDoc[];
  entries.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      mealOrder(a.meal) - mealOrder(b.meal) ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  );
  return { from, to, entries: await views(entries) };
}

/** The keys of the allergens this member avoids. */
async function avoidedKeys(userId: Types.ObjectId): Promise<Set<string>> {
  const rows = await UserAllergen.find({ userId, mode: "avoid" }, { allergenId: 1 }).lean();
  if (rows.length === 0) return new Set();
  const allergens = await Allergen.find(
    { _id: { $in: rows.map((r) => r.allergenId) } },
    { key: 1 },
  ).lean();
  return new Set(allergens.map((a) => a.key));
}

let indexesReady: Promise<unknown> | undefined;
/** The requestId unique index must exist before the first insert relies on it (#51). */
const ensureIndexes = () =>
  (indexesReady ??= LogEntry.createIndexes().catch((err: unknown) => {
    indexesReady = undefined;
    throw err;
  }));

const isDuplicate = (err: unknown) => (err as { code?: number }).code === 11000;

/** An entry's answer: the entry plus every avoid-mode allergen its food matched. */
async function created(
  userId: Types.ObjectId,
  entry: EntryDoc,
  allergens: AllergenAlert[],
): Promise<LogEntryCreated> {
  const avoided = await avoidedKeys(userId);
  const [view] = await views([entry]);
  return { entry: view, alerts: allergens.filter((a) => avoided.has(a.key)) };
}

/**
 * The entry an earlier create with this requestId wrote, answered again. A different food, amount,
 * meal or date under the same requestId is a client bug, refused with 409. A repeat without a date
 * keeps the first request's date, so a retry that lands after midnight still matches.
 */
async function replay(
  userId: Types.ObjectId,
  input: LogEntryCreateInput,
  now: Date,
): Promise<LogEntryCreated | null> {
  const first = (await LogEntry.findOne({
    userId,
    requestId: input.requestId,
  }).lean()) as EntryDoc | null;
  if (!first) return null;
  if (
    first.fdcId !== input.fdcId ||
    first.grams !== input.grams ||
    first.meal !== input.meal ||
    (input.date !== undefined && first.date !== input.date)
  )
    throw new HttpError(409, "request_id_conflict", "this requestId already logged another entry");
  const food = await getFood(first.fdcId, now);
  return created(userId, first, food.allergens);
}

/**
 * POST /api/users/me/logs. The food is fetched from USDA and matched against the allergen dictionary
 * first when it is not cached (R3-25), so the entry never points at an unknown food and the alert check
 * sees its allergens. A date after the member's today is refused; an earlier date backfills a past day
 * and still returns its alerts (R3-26). With a `requestId` the create is idempotent (#51): a repeat
 * answers the first entry with `created: false` and writes nothing, also when two copies race (the
 * unique index lets one insert win and the other reads it back).
 */
export async function createLog(
  userId: Types.ObjectId,
  input: LogEntryCreateInput,
  now = new Date(),
): Promise<LogEntryCreated & { created: boolean }> {
  if (input.requestId) {
    await ensureIndexes();
    const again = await replay(userId, input, now);
    if (again) return { ...again, created: false };
  }
  const today = await memberToday(userId, now);
  const date = input.date ?? today;
  if (date > today)
    throw new HttpError(400, "date_in_future", `the latest date you can log is ${today}`);
  const food = await getFood(input.fdcId, now);
  let entry;
  try {
    entry = await LogEntry.create({
      userId,
      date,
      meal: input.meal,
      fdcId: food.fdcId,
      grams: input.grams,
      source: "search",
      confidence: 1,
      createdAt: now,
      ...(input.requestId ? { requestId: input.requestId } : {}),
    });
  } catch (err) {
    if (!input.requestId || !isDuplicate(err)) throw err;
    const winner = await replay(userId, input, now);
    if (!winner) throw err;
    return { ...winner, created: false };
  }
  return { ...(await created(userId, entry.toObject() as EntryDoc, food.allergens)), created: true };
}

/** PUT /api/logs/:id: grams and meal only (R3-27); the entry was already checked to be the caller's. */
export async function updateLog(
  entry: LogEntryDoc,
  input: LogEntryUpdateInput,
): Promise<LogEntryView> {
  if (input.grams !== undefined) entry.grams = input.grams;
  if (input.meal !== undefined) entry.meal = input.meal;
  await entry.save();
  const [view] = await views([entry.toObject() as EntryDoc]);
  return view;
}

/** The default mode for an allergen tier (design doc D12): true allergies alert, sensitivities count. */
const defaultMode = (tier: AllergenTier): AllergenMode =>
  tier === "sensitivity" ? "track" : "avoid";

/** GET /api/users/me/allergens. A setting whose allergen was deleted from the dictionary is not shown. */
export async function listUserAllergens(userId: Types.ObjectId): Promise<UserAllergenView[]> {
  const rows = await UserAllergen.find({ userId }).lean();
  if (rows.length === 0) return [];
  const allergens = await Allergen.find(
    { _id: { $in: rows.map((r) => r.allergenId) } },
    { key: 1, displayName: 1 },
  ).lean();
  const byId = new Map(allergens.map((a) => [String(a._id), a]));
  return rows
    .flatMap((r) => {
      const a = byId.get(String(r.allergenId));
      return a
        ? [
            {
              key: a.key,
              displayName: a.displayName,
              mode: r.mode as AllergenMode,
              weeklyThreshold: r.mode === "track" ? (r.weeklyThreshold ?? null) : null,
            },
          ]
        : [];
    })
    .sort((x, y) => x.displayName.localeCompare(y.displayName, "en"));
}

/**
 * PUT /api/users/me/allergens: the list replaces the stored one. Unknown keys are refused before anything
 * is written. The write is one ordered bulkWrite (drop the settings not in the list, upsert the rest), so
 * a repeat of the same request converges on the same rows (no transaction, D6 style).
 */
export async function setUserAllergens(
  userId: Types.ObjectId,
  input: UserAllergensInput,
): Promise<UserAllergenView[]> {
  const dictionary = new Map((await loadDictionary()).map((e) => [e.key, e]));
  const unknown = input.allergens.map((a) => a.key).filter((k) => !dictionary.has(k));
  if (unknown.length > 0) throw new HttpError(400, "unknown_allergen", { keys: unknown });
  const settings = input.allergens.map((a, i) => {
    const entry = dictionary.get(a.key)!;
    const mode = a.mode ?? defaultMode(entry.tier);
    // The schema refuses a threshold with an explicit avoid; a tier that defaults to avoid must refuse it too
    // rather than drop it without a word.
    if (a.weeklyThreshold !== undefined && mode !== "track") {
      throw new HttpError(400, "validation_error", [
        {
          path: `allergens.${i}.weeklyThreshold`,
          message: `weeklyThreshold applies to track mode only; ${a.key} defaults to avoid, so send mode: "track"`,
        },
      ]);
    }
    return {
      allergenId: entry.id,
      mode,
      weeklyThreshold: mode === "track" ? (a.weeklyThreshold ?? null) : null,
    };
  });
  await UserAllergen.bulkWrite(
    [
      {
        deleteMany: { filter: { userId, allergenId: { $nin: settings.map((s) => s.allergenId) } } },
      },
      ...settings.map((s) => ({
        updateOne: {
          filter: { userId, allergenId: s.allergenId },
          update: { $set: { mode: s.mode, weeklyThreshold: s.weeklyThreshold } },
          upsert: true,
        },
      })),
    ],
    { ordered: true },
  );
  return listUserAllergens(userId);
}
