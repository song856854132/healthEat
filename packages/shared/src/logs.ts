import { z } from "zod";
import { AllergenKey, FoodAllergenMatch } from "./allergens.js";
import { FdcIdParam } from "./foods.js";

/** Meals a log entry belongs to (design doc, Data model: LogEntry). */
export const MEALS = ["breakfast", "lunch", "dinner", "snack"] as const;
export const Meal = z.enum(MEALS);
export type Meal = z.infer<typeof Meal>;

/** How an entry was made: picked from search, or estimated from a meal photo (phase 2). */
export const LOG_SOURCES = ["search", "photo"] as const;
export const LogSource = z.enum(LOG_SOURCES);
export type LogSource = z.infer<typeof LogSource>;

/** Largest portion one entry may log: 5 kg covers any real serving and stops typos like 50000. */
export const MAX_LOG_GRAMS = 5000;
/** Widest range GET /api/users/me/logs returns at once: about three months of day logs. */
export const MAX_LOG_RANGE_DAYS = 92;

/** A calendar date, YYYY-MM-DD, that exists (no 2026-02-30). */
export const LogDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "not a calendar date");
export type LogDate = z.infer<typeof LogDate>;

const Grams = z.number().positive().max(MAX_LOG_GRAMS);

/**
 * Body of POST /api/users/me/logs. `date` is optional: the API uses today in the member's time zone,
 * and refuses a date after that day (backfilling a past day is allowed). `requestId` is optional: a
 * UUID the client makes once per "log this" tap and resends on a retry, so a double tap or a retried
 * request writes one entry, not two (owner decision #51).
 */
export const LogEntryCreateInput = z.strictObject({
  fdcId: FdcIdParam.pipe(z.number()),
  grams: Grams,
  meal: Meal,
  date: LogDate.optional(),
  requestId: z.uuid().optional(),
});
export type LogEntryCreateInput = z.infer<typeof LogEntryCreateInput>;

/** Body of PUT /api/logs/:id: grams and meal only. The date and the food are fixed once logged (R3-27). */
export const LogEntryUpdateInput = z
  .strictObject({ grams: Grams.optional(), meal: Meal.optional() })
  .refine((v) => v.grams !== undefined || v.meal !== undefined, "send grams, meal or both");
export type LogEntryUpdateInput = z.infer<typeof LogEntryUpdateInput>;

/** Query of GET /api/users/me/logs. Both bounds are inclusive; either one alone means that single day. */
export const LogsQuery = z
  .object({ from: LogDate.optional(), to: LogDate.optional() })
  .refine((q) => !q.from || !q.to || q.from <= q.to, "from must not be after to")
  .refine(
    (q) =>
      !q.from ||
      !q.to ||
      (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86_400_000 <
        MAX_LOG_RANGE_DAYS,
    `at most ${MAX_LOG_RANGE_DAYS} days at once`,
  );
export type LogsQuery = z.infer<typeof LogsQuery>;

/** A log entry as the API returns it. `description` is the cached food's name (null if it is gone). */
export const LogEntryView = z.object({
  id: z.string(),
  date: LogDate,
  meal: Meal,
  fdcId: z.number().int().positive(),
  description: z.string().nullable(),
  grams: z.number().positive(),
  source: LogSource,
  confidence: z.number().min(0).max(1),
  createdAt: z.string().datetime(),
});
export type LogEntryView = z.infer<typeof LogEntryView>;

/** Response of GET /api/users/me/logs: the entries in the range, by date, then meal, then time. */
export const LogListResponse = z.object({
  from: LogDate,
  to: LogDate,
  entries: z.array(LogEntryView),
});
export type LogListResponse = z.infer<typeof LogListResponse>;

/** A hard alert: the logged food matched an allergen the member avoids. */
export const AllergenAlert = FoodAllergenMatch;
export type AllergenAlert = z.infer<typeof AllergenAlert>;

/**
 * Response of POST /api/users/me/logs. `alerts` lists every avoid-mode allergen the food matched,
 * whatever the entry's date (a backfilled entry is flagged too, R3-26); the Home alert strip shows today only.
 */
export const LogEntryCreated = z.object({ entry: LogEntryView, alerts: z.array(AllergenAlert) });
export type LogEntryCreated = z.infer<typeof LogEntryCreated>;

/** What the member does about an allergen: `avoid` raises a hard alert, `track` counts toward a weekly meter. */
export const ALLERGEN_MODES = ["avoid", "track"] as const;
export const AllergenMode = z.enum(ALLERGEN_MODES);
export type AllergenMode = z.infer<typeof AllergenMode>;

/** One entry of the member's allergen list. `mode` defaults from the allergen's tier; threshold is for track mode. */
export const UserAllergenInput = z
  .strictObject({
    key: AllergenKey,
    mode: AllergenMode.optional(),
    weeklyThreshold: z.number().int().positive().max(1000).optional(),
  })
  .refine((a) => a.weeklyThreshold === undefined || a.mode !== "avoid", {
    message: "weeklyThreshold applies to track mode only",
    path: ["weeklyThreshold"],
  });
export type UserAllergenInput = z.infer<typeof UserAllergenInput>;

/** Body of PUT /api/users/me/allergens: the complete list (it replaces the stored one). */
export const UserAllergensInput = z.strictObject({
  allergens: z
    .array(UserAllergenInput)
    .max(100)
    .refine((list) => new Set(list.map((a) => a.key)).size === list.length, "each key once"),
});
export type UserAllergensInput = z.infer<typeof UserAllergensInput>;

/** One stored setting, as GET/PUT /api/users/me/allergens return it. */
export const UserAllergenView = z.object({
  key: AllergenKey,
  displayName: z.string(),
  mode: AllergenMode,
  weeklyThreshold: z.number().int().positive().nullable(),
});
export type UserAllergenView = z.infer<typeof UserAllergenView>;

/** Response of GET/PUT /api/users/me/allergens, ordered by display name. */
export const UserAllergensResponse = z.object({ allergens: z.array(UserAllergenView) });
export type UserAllergensResponse = z.infer<typeof UserAllergensResponse>;
