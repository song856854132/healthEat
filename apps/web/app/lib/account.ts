import { MemberProfileView } from "@healtheat/shared";
import type { MemberProfileInput } from "@healtheat/shared";
import { apiFetch } from "./api";

// The signed-in account's own data (apps/api/README.md: GET/PUT /api/users/me/profiles/member,
// DELETE /api/users/me). Same-origin through the /api/* rewrite, like every browser call.

export type AccountFailure = { status: number; error: string; message: string };
export type AccountResult<T> = { ok: true; data: T } | { ok: false; failure: AccountFailure };

type ErrorBody = { error?: unknown; details?: unknown };

const MESSAGES: Record<string, string> = {
  network: "Could not reach the server. Check your connection and try again.",
  bad_response: "The server sent an unexpected response. Try again.",
  unauthenticated: "Your session has ended. Log in again.",
  account_suspended: "This account is suspended.",
  account_deletion_pending: "This account is being deleted.",
  validation_error: "Some fields are not valid.",
  last_admin:
    "You are the only Admin, so this account cannot be deleted until another Admin exists.",
  database_unavailable: "The database is not answering right now. Try again in a moment.",
};

const fail = (status: number, error: string): AccountResult<never> => ({
  ok: false,
  failure: {
    status,
    error,
    message: MESSAGES[error] ?? `Something went wrong (${error}). Try again.`,
  },
});

async function call(url: string, init: RequestInit = {}): Promise<Response | AccountResult<never>> {
  try {
    // apiFetch: a 401 here also tells the nav the session is gone.
    return await apiFetch(url, init);
  } catch (err) {
    if (init.signal?.aborted) throw err; // the caller moved on; nothing to show
    return fail(0, "network");
  }
}

async function failure(res: Response): Promise<AccountResult<never>> {
  const body = (await res.json().catch(() => ({}))) as ErrorBody;
  return fail(res.status, typeof body.error === "string" ? body.error : `http_${res.status}`);
}

async function profileFrom(res: Response | AccountResult<never>) {
  if (!(res instanceof Response)) return res;
  if (!res.ok) return failure(res);
  const parsed = MemberProfileView.safeParse(await res.json().catch(() => undefined));
  return parsed.success
    ? ({ ok: true, data: parsed.data } as const)
    : fail(res.status, "bad_response");
}

/** GET /api/users/me/profiles/member. Rejects only when `signal` aborted it. */
export async function getMemberProfile(
  signal?: AbortSignal,
): Promise<AccountResult<MemberProfileView>> {
  return profileFrom(await call("/api/users/me/profiles/member", { signal }));
}

/** PUT /api/users/me/profiles/member: absent fields stay, `null` clears. */
export async function updateMemberProfile(
  body: MemberProfileInput,
): Promise<AccountResult<MemberProfileView>> {
  return profileFrom(
    await call("/api/users/me/profiles/member", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * DELETE /api/users/me (T5 cascade): 204 when the account and everything it owns is gone and the
 * session ended. The only usable Admin gets 409 last_admin.
 */
export async function deleteAccount(): Promise<AccountResult<null>> {
  const res = await call("/api/users/me", { method: "DELETE" });
  if (!(res instanceof Response)) return res;
  return res.status === 204 ? { ok: true, data: null } : failure(res);
}
