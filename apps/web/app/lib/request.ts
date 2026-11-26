import { apiFetch } from "./api";
import { NETWORK } from "./foods";
import type { Failure } from "./foods";

// One browser-side call for the Curator and Admin pages (T21): same-origin through the /api/* rewrite,
// the 2xx body parsed with the shared schema, and an error body reduced to a message for the page. The
// status rides along on success because a dictionary write answers 202 while its re-match has foods left.

/** A failed call; `details` is the API's own `details` (for example how many members avoid an allergen). */
export type ApiFailure = Failure & { details?: unknown };

export type ApiResult<T> =
  { ok: true; status: number; data: T } | { ok: false; failure: ApiFailure };

type Schema<T> = { safeParse: (v: unknown) => { success: true; data: T } | { success: false } };

/** For routes that answer 204 with no body. */
export const NO_BODY: Schema<null> = { safeParse: () => ({ success: true, data: null }) };

const BAD_BODY: ApiFailure = {
  status: 0,
  error: "bad_response",
  message: "The server sent an unexpected response. Try again.",
};

// apps/api/README.md, error table: the answers every one of these routes can give.
const COMMON: Record<string, string> = {
  unauthenticated: "Your session has ended. Log in again.",
  forbidden: "This account does not hold the role this needs.",
  account_suspended: "This account is suspended.",
  account_deletion_pending: "This account is being deleted. Log in again to finish deleting it.",
  validation_error: "Some fields are not valid.",
  database_unavailable: "The database is not answering right now. Try again in a moment.",
};

/** A JSON request body for `request`. */
export function jsonBody(method: "POST" | "PUT", body?: unknown): RequestInit {
  return body === undefined
    ? { method }
    : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/**
 * Calls an API route; never rejects unless `init.signal` aborted it. `messages` words the route's own
 * errors; anything unknown still gets a message that names the error.
 */
export async function request<T>(
  url: string,
  schema: Schema<T>,
  init: RequestInit = {},
  messages: Record<string, string> = {},
): Promise<ApiResult<T>> {
  let res: Response;
  try {
    // apiFetch: a 401 also tells the nav the session is gone.
    res = await apiFetch(url, init);
  } catch (err) {
    if (init.signal?.aborted) throw err; // the caller moved on; nothing to show
    return { ok: false, failure: NETWORK };
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown; details?: unknown };
    const error = typeof body.error === "string" ? body.error : `http_${res.status}`;
    return {
      ok: false,
      failure: {
        status: res.status,
        error,
        message: messages[error] ?? COMMON[error] ?? `Something went wrong (${error}). Try again.`,
        details: body.details,
      },
    };
  }
  const raw: unknown = res.status === 204 ? null : await res.json().catch(() => undefined);
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? { ok: true, status: res.status, data: parsed.data }
    : { ok: false, failure: BAD_BODY };
}

/** The field paths a 400 validation_error named, mapped to their top-level field ("synonyms.3" -> "synonyms"). */
export function fieldErrors(failure: ApiFailure): Record<string, string> {
  const fields: Record<string, string> = {};
  if (failure.error !== "validation_error" || !Array.isArray(failure.details)) return fields;
  for (const d of failure.details as { path?: unknown; message?: unknown }[]) {
    const key = typeof d.path === "string" ? d.path.split(".")[0] : "";
    if (key && typeof d.message === "string") fields[key] ??= d.message;
  }
  return fields;
}
