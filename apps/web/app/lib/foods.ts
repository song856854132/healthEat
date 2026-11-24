import {
  FOOD_DATA_TYPES,
  FOOD_SEARCH_MAX_PAGE,
  FoodDetails,
  FoodSearchResponse,
  LogEntryCreated,
} from "@healtheat/shared";
import { LogDate } from "@healtheat/shared";
import type { FoodDataType, LogEntryCreateInput } from "@healtheat/shared";
import { apiFetch } from "./api";

// Browser-side calls to the food and log routes (apps/api/README.md, REST table). Same-origin only:
// the Next.js rewrite proxies /api/* to Express, so there is no API URL in the client and the
// session cookie rides along for the log call.

/**
 * Search criteria as the URL carries them (design doc: "State lives in the URL"). `date` is the day a
 * "Log this" should go to when the search started from a past day's log (/log/[date], "Add food"); it
 * rides along to Details. Without it, logs go to today.
 */
export type SearchCriteria = { q: string; dataType?: FoodDataType; page: number; date?: string };

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Reads /search?q=&dataType=&page= leniently: a hand-edited URL with an unknown data type or a bad
 * page still searches (all types, page 1) instead of failing. Whitespace in `q` is collapsed the way
 * the API's `FoodSearchQuery` does, so the URL and the cache key agree.
 */
export function readCriteria(params: Params): SearchCriteria {
  const q = (first(params.q) ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
  const rawType = first(params.dataType);
  const dataType = FOOD_DATA_TYPES.find((t) => t === rawType);
  const n = Number(first(params.page));
  const page = Number.isInteger(n) && n >= 1 ? Math.min(n, FOOD_SEARCH_MAX_PAGE) : 1;
  const date = readLogDate(params.date);
  return date ? { q, dataType, page, date } : { q, dataType, page };
}

/** A `date` URL parameter if it is a real calendar date (YYYY-MM-DD), else undefined (log to today). */
export function readLogDate(value: string | string[] | undefined): string | undefined {
  const parsed = LogDate.safeParse(first(value));
  return parsed.success ? parsed.data : undefined;
}

/** Details for a food; with a log date, "Log this" logs to that day. */
export function foodHref(fdcId: number, date?: string, hash = ""): string {
  return `/food/${fdcId}${date ? `?date=${date}` : ""}${hash}`;
}

/** The /search URL for these criteria; page 1 and "all types" are left out to keep URLs short. */
export function searchHref({ q, dataType, page, date }: SearchCriteria): string {
  const sp = new URLSearchParams({ q });
  if (dataType) sp.set("dataType", dataType);
  if (page > 1) sp.set("page", String(page));
  if (date) sp.set("date", date);
  return `/search?${sp.toString()}`;
}

/** A failed call, reduced to what the page shows. */
export type Failure = { status: number; error: string; message: string };

type ErrorBody = { error?: unknown; details?: unknown };

export const NETWORK: Failure = {
  status: 0,
  error: "network",
  message: "Could not reach the server. Check your connection and try again.",
};
const BAD_BODY: Failure = {
  status: 0,
  error: "bad_response",
  message: "The server sent an unexpected response. Try again.",
};

const MESSAGES: Record<string, string> = {
  usda_unavailable: "USDA FoodData Central is unavailable right now. Try again in a few minutes.",
  usda_unconfigured: "Food search is not set up on this deployment (no USDA key).",
  food_not_found: "USDA has no food with this id.",
  validation_error: "That request is not valid.",
  unauthenticated: "Log in to log this food.",
  forbidden: "This account cannot log foods.",
  account_suspended: "This account is suspended.",
  account_deletion_pending: "This account is being deleted.",
  date_in_future: "That date is after today.",
  request_id_conflict: "This log changed while it was being sent. Tap Log again.",
  log_not_found: "This entry no longer exists; it may have been deleted in another tab.",
  database_unavailable: "The database is not answering right now. Try again in a moment.",
};

export async function failure(res: Response): Promise<Failure> {
  const body = (await res.json().catch(() => ({}))) as ErrorBody;
  const error = typeof body.error === "string" ? body.error : `http_${res.status}`;
  // The API words usda_unavailable for users (README error table); prefer its text when present.
  const sent = error === "usda_unavailable" && typeof body.details === "string" ? body.details : "";
  const message =
    (sent && `${sent.charAt(0).toUpperCase()}${sent.slice(1)}.`) ||
    MESSAGES[error] ||
    `Something went wrong (${error}). Try again.`;
  return { status: res.status, error, message };
}

export type Result<T> = { ok: true; data: T } | { ok: false; failure: Failure };

/** Calls an API route and parses a 2xx body with `schema`; never rejects unless `init.signal` aborted. */
export async function getJson<T>(
  url: string,
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } },
  init: RequestInit = {},
): Promise<Result<T>> {
  let res: Response;
  try {
    // apiFetch: a 401 from the log call also tells the nav the session is gone.
    res = await apiFetch(url, init);
  } catch (err) {
    if (init.signal?.aborted) throw err; // the caller moved on; nothing to show
    return { ok: false, failure: NETWORK };
  }
  if (!res.ok) return { ok: false, failure: await failure(res) };
  const parsed = schema.safeParse(await res.json().catch(() => undefined));
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, failure: BAD_BODY };
}

/** GET /api/foods/search. Rejects only when `signal` aborted it. */
export function searchFoods(
  { q, dataType, page }: SearchCriteria,
  signal?: AbortSignal,
): Promise<Result<FoodSearchResponse>> {
  const sp = new URLSearchParams({ q, page: String(page) });
  if (dataType) sp.set("dataType", dataType);
  return getJson(`/api/foods/search?${sp.toString()}`, FoodSearchResponse, { signal });
}

/** GET /api/foods/:fdcId. Rejects only when `signal` aborted it. */
export function getFood(fdcId: number, signal?: AbortSignal): Promise<Result<FoodDetails>> {
  return getJson(`/api/foods/${fdcId}`, FoodDetails, { signal });
}

/** POST /api/users/me/logs (member). A 401 means signed out: the page asks the user to log in. */
export function logFood(body: LogEntryCreateInput): Promise<Result<LogEntryCreated>> {
  return getJson("/api/users/me/logs", LogEntryCreated, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
