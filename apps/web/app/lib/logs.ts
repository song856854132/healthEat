import { LogEntryView, LogListResponse, MemberProfileView } from "@healtheat/shared";
import type { LogEntryUpdateInput, Meal } from "@healtheat/shared";
import { apiFetch } from "./api";
import { NETWORK, failure, getJson } from "./foods";
import type { Result } from "./foods";

// Browser-side calls for the day log (apps/api/README.md, REST table: GET /api/users/me/logs,
// PUT/DELETE /api/logs/:id) and the date helpers /log/[date] uses. Same-origin through the rewrite.

/** A starting meal from the browser's clock; the user can change it. */
export function mealForHour(hour: number): Meal {
  if (hour >= 5 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 15) return "lunch";
  if (hour >= 17 && hour < 22) return "dinner";
  return "snack";
}

/**
 * One id per log (#51), resent on a retry so the API writes the entry once. crypto.randomUUID needs a
 * secure context (https or localhost); without it, log without an id.
 */
export function newRequestId(): string | undefined {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : undefined;
}

export const MEAL_LABELS: Record<Meal, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
};

/** GET /api/users/me/logs?from=&to= (inclusive); neither bound means today in the member's time zone. */
export function listLogs(
  range: { from?: string; to?: string },
  signal?: AbortSignal,
): Promise<Result<LogListResponse>> {
  const sp = new URLSearchParams();
  if (range.from) sp.set("from", range.from);
  if (range.to) sp.set("to", range.to);
  const qs = sp.toString();
  return getJson(`/api/users/me/logs${qs ? `?${qs}` : ""}`, LogListResponse, { signal });
}

/**
 * The member's time zone (GET /api/users/me/profiles/member), which decides what "today" is: the API
 * refuses a log date after today there, so the day log uses the same zone, not the browser's.
 */
export async function memberTimeZone(signal?: AbortSignal): Promise<Result<string>> {
  const result = await getJson("/api/users/me/profiles/member", MemberProfileView, { signal });
  return result.ok ? { ok: true, data: result.data.timezone } : result;
}

/** PUT /api/logs/:id: grams and/or meal (the date and the food are fixed once logged, R3-27). */
export function updateLog(id: string, body: LogEntryUpdateInput): Promise<Result<LogEntryView>> {
  return getJson(`/api/logs/${encodeURIComponent(id)}`, LogEntryView, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** DELETE /api/logs/:id: 204 when deleted. */
export async function deleteLog(id: string): Promise<Result<null>> {
  let res: Response;
  try {
    res = await apiFetch(`/api/logs/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch {
    return { ok: false, failure: NETWORK };
  }
  return res.status === 204 ? { ok: true, data: null } : { ok: false, failure: await failure(res) };
}

/** Today's date (YYYY-MM-DD) in an IANA time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  // From the parts, not a locale's whole format: no locale's date layout is guaranteed to stay
  // YYYY-MM-DD across browser versions.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
}

/** The calendar date `days` after `date` (negative goes back). Pure date arithmetic, in UTC. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "Wednesday, November 18, 2026" for a YYYY-MM-DD date, the same in every time zone. */
export function formatLogDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** A logged amount as the member entered it: up to one decimal, with thousands separators. */
export function formatGrams(grams: number): string {
  return grams.toLocaleString("en-US", { maximumFractionDigits: 1 });
}
