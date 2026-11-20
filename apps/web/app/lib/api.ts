import { MeResponse } from "@healtheat/shared";

// Same-origin calls only: the Next.js rewrite proxies /api/* to Express, so the session cookie
// (he_sid, HttpOnly, set by the server) rides along without CORS or an API URL in the client.

/** A failed API call, reduced to what a form shows: one message per field plus a form-level one. */
export type FormErrors = { form?: string; fields: Record<string, string> };

type ErrorBody = { error?: string; details?: unknown };

const NETWORK_ERROR = "Could not reach the server. Check your connection.";
const BAD_RESPONSE = "The server sent an unexpected response. Try again.";

// apps/api/src/middleware/auth.ts: no session (401), or a suspended or deleting account (403).
const SIGNED_OUT_ERRORS = new Set([
  "unauthenticated",
  "account_suspended",
  "account_deletion_pending",
]);

const CONFLICT_MESSAGES: Record<string, string> = {
  username: "That username is taken.",
  email: "An account with that email already exists.",
};

// Called when any API answer says the session is gone (401 `unauthenticated`), so the nav stops
// showing an account the server no longer recognises (expiry, suspension, logout in another tab).
const signedOutListeners = new Set<() => void>();

export function onSignedOut(listener: () => void): () => void {
  signedOutListeners.add(listener);
  return () => {
    signedOutListeners.delete(listener);
  };
}

/**
 * Same-origin fetch for every API call from the browser. A 401 `unauthenticated` notifies the
 * `onSignedOut` listeners; the response is returned untouched either way.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
  if (res.status === 401) {
    const body = (await res
      .clone()
      .json()
      .catch(() => ({}))) as ErrorBody;
    if (body.error === "unauthenticated") for (const listener of signedOutListeners) listener();
  }
  return res;
}

/**
 * GET /api/auth/me: the signed-in account, or null when the server says there is no session (401,
 * or 403 for a suspended or deleted account, whose session the API destroys on the spot). Rejects on
 * anything else (5xx, network error, unexpected body): that says nothing about the session.
 */
export async function fetchMe(signal?: AbortSignal): Promise<MeResponse | null> {
  const res = await apiFetch("/api/auth/me", { signal });
  if (res.status === 401 || res.status === 403) {
    // Only the API's own answers end the session in the UI; a 401/403 from anything in front of it
    // (a protection page, a firewall, a proxy) says nothing about the session.
    const body = (await res.json().catch(() => ({}))) as ErrorBody;
    if (body.error && SIGNED_OUT_ERRORS.has(body.error)) return null;
    throw new Error(
      `GET /api/auth/me answered ${res.status} ${body.error ?? "without an API error"}`,
    );
  }
  if (!res.ok) throw new Error(`GET /api/auth/me answered ${res.status}`);
  const parsed = MeResponse.safeParse(await res.json());
  if (!parsed.success) throw new Error("GET /api/auth/me sent an unexpected body");
  return parsed.data;
}

/**
 * POST /api/auth/logout (idempotent: 200 even without a session). Anything but 2xx, or no answer at
 * all, leaves the server session alive, so the caller must keep showing it.
 */
export async function logout(): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await apiFetch("/api/auth/logout", { method: "POST" });
    if (res.ok) return { ok: true };
    return { ok: false, message: `Could not log out (HTTP ${res.status}). Try again.` };
  } catch {
    return { ok: false, message: NETWORK_ERROR };
  }
}

export type AuthResult =
  { ok: true; me: MeResponse } | { ok: false; errors: FormErrors; invalidPaths: string[] };

/**
 * POST a JSON body; resolves to the account on success or the mapped form errors. Never rejects.
 * `knownFields` are the inputs the form renders; errors for any other path go to the form-level
 * message so they are never silently dropped. `invalidPaths` lists every path a 400
 * validation_error named, so a caller can retry with a corrected value.
 */
export async function postAuth(
  path: "/api/auth/register" | "/api/auth/login",
  body: unknown,
  knownFields: readonly string[],
): Promise<AuthResult> {
  const fail = (form: string): AuthResult => ({
    ok: false,
    errors: { form, fields: {} },
    invalidPaths: [],
  });
  let res: Response;
  try {
    res = await apiFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return fail(NETWORK_ERROR);
  }
  if (res.ok) {
    // A 2xx that is not a MeResponse (a protection page, a misrouted rewrite, a proxy stub) must not
    // hang the form or reach the nav, which reads me.user.
    const parsed = MeResponse.safeParse(await res.json().catch(() => undefined));
    return parsed.success ? { ok: true, me: parsed.data } : fail(BAD_RESPONSE);
  }
  const parsed = (await res.json().catch(() => ({}))) as ErrorBody;
  return {
    ok: false,
    errors: mapApiError(res.status, parsed, knownFields),
    invalidPaths: validationPaths(parsed),
  };
}

function validationPaths(body: ErrorBody): string[] {
  if (body.error !== "validation_error" || !Array.isArray(body.details)) return [];
  return (body.details as { path?: unknown }[])
    .map((d) => d.path)
    .filter((p): p is string => typeof p === "string");
}

/** "too many attempts, try again in 3 minutes" -> "Too many attempts, try again in 3 minutes." */
function sentence(text: string): string {
  const t = text.trim();
  return t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : ".");
}

/** Map the API's JSON error body (apps/api/README.md, error table) onto form errors. */
export function mapApiError(
  status: number,
  body: ErrorBody,
  knownFields: readonly string[],
): FormErrors {
  const fields: Record<string, string> = {};
  const other: string[] = [];
  const put = (path: string, message: string) => {
    if (knownFields.includes(path)) fields[path] ??= message;
    else other.push(path === "timezone" ? `Time zone: ${message}` : message);
  };

  switch (body.error) {
    case "validation_error": {
      if (Array.isArray(body.details)) {
        for (const d of body.details as { path?: unknown; message?: unknown }[]) {
          const path = typeof d.path === "string" ? d.path : "";
          put(path, typeof d.message === "string" ? d.message : "Invalid value");
        }
      }
      const form = other.length
        ? other.join(" ")
        : Object.keys(fields).length
          ? undefined
          : "Some fields are not valid.";
      return { form, fields };
    }
    case "conflict": {
      const names = (body.details as { fields?: unknown } | undefined)?.fields;
      let unshown = false;
      if (Array.isArray(names)) {
        for (const n of names) {
          if (typeof n === "string" && knownFields.includes(n))
            fields[n] = CONFLICT_MESSAGES[n] ?? `That ${n} is taken.`;
          else unshown = true;
        }
      }
      const form =
        unshown || !Object.keys(fields).length
          ? "An account with those details already exists."
          : undefined;
      return { form, fields };
    }
    case "username_reserved":
      put("username", "That username is reserved.");
      return { form: other[0], fields };
    case "invalid_credentials":
      return { form: "Wrong username or password.", fields };
    case "account_suspended":
      return { form: "This account is suspended.", fields };
    case "account_deletion_pending":
      return { form: "This account is being deleted and can no longer sign in.", fields };
    case "too_many_attempts":
      // The API words the wait itself (apps/api/src/services/throttle.ts); show it as sent.
      return {
        form:
          typeof body.details === "string" && body.details.trim()
            ? sentence(body.details)
            : "Too many attempts. Try again later.",
        fields,
      };
    default:
      return {
        form: `Something went wrong (${body.error ?? `HTTP ${status}`}). Try again.`,
        fields,
      };
  }
}
