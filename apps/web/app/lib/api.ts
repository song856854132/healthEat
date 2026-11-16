import type { MeResponse } from "@healtheat/shared";

// Same-origin calls only: the Next.js rewrite proxies /api/* to Express, so the session cookie
// (he_sid, HttpOnly, set by the server) rides along without CORS or an API URL in the client.

/** A failed API call, reduced to what a form shows: one message per field plus a form-level one. */
export type FormErrors = { form?: string; fields: Record<string, string> };

type ErrorBody = { error?: string; details?: unknown };

const CONFLICT_MESSAGES: Record<string, string> = {
  username: "That username is taken.",
  email: "An account with that email already exists.",
};

/** GET /api/auth/me: the signed-in account, or null when the API answers 401 (signed out). */
export async function fetchMe(): Promise<MeResponse | null> {
  const res = await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`GET /api/auth/me answered ${res.status}`);
  return (await res.json()) as MeResponse;
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
}

/** POST a JSON body; resolves to the parsed MeResponse on success or the mapped form errors. */
export async function postAuth(
  path: "/api/auth/register" | "/api/auth/login",
  body: unknown,
): Promise<{ ok: true; me: MeResponse } | { ok: false; errors: FormErrors }> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return {
      ok: false,
      errors: { form: "Could not reach the server. Check your connection.", fields: {} },
    };
  }
  if (res.ok) return { ok: true, me: (await res.json()) as MeResponse };
  const parsed = (await res.json().catch(() => ({}))) as ErrorBody;
  return {
    ok: false,
    errors: mapApiError(res.status, parsed, res.headers.get("retry-after")),
  };
}

/** Map the API's JSON error body (apps/api/README.md, error table) onto form errors. */
export function mapApiError(
  status: number,
  body: ErrorBody,
  retryAfter: string | null = null,
): FormErrors {
  const fields: Record<string, string> = {};
  switch (body.error) {
    case "validation_error": {
      if (Array.isArray(body.details)) {
        for (const d of body.details as { path?: unknown; message?: unknown }[]) {
          const path = typeof d.path === "string" && d.path ? d.path : undefined;
          const message = typeof d.message === "string" ? d.message : "Invalid value";
          if (path && !fields[path]) fields[path] = message;
        }
      }
      const form = Object.keys(fields).length ? undefined : "Some fields are not valid.";
      return { form, fields };
    }
    case "conflict": {
      const names = (body.details as { fields?: unknown } | undefined)?.fields;
      if (Array.isArray(names)) {
        for (const n of names) {
          if (typeof n === "string") fields[n] = CONFLICT_MESSAGES[n] ?? `That ${n} is taken.`;
        }
      }
      return Object.keys(fields).length
        ? { fields }
        : { form: "An account with those details already exists.", fields };
    }
    case "username_reserved":
      return { fields: { username: "That username is reserved." } };
    case "invalid_credentials":
      return { form: "Wrong username or password.", fields };
    case "account_suspended":
      return { form: "This account is suspended.", fields };
    case "account_deletion_pending":
      return { form: "This account is being deleted and can no longer sign in.", fields };
    case "too_many_attempts": {
      const seconds = Number(retryAfter);
      const minutes = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : 15;
      return {
        form: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        fields,
      };
    }
    default:
      return {
        form: `Something went wrong (${body.error ?? `HTTP ${status}`}). Try again.`,
        fields,
      };
  }
}
