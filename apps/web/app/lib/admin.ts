import {
  ACCOUNT_STATUSES,
  AdminProfileView,
  AdminUserDetail,
  AdminUserListResponse,
  ROLES,
} from "@healtheat/shared";
import type { AccountStatus, AdminProfileInput, Role } from "@healtheat/shared";
import { NO_BODY, jsonBody, request } from "./request";
import type { ApiResult } from "./request";

// Browser-side calls for the Admin pages (T21 web half; apps/api/README.md, REST table). Admin manages
// accounts only (D18): account fields and which profiles exist, never logs or the dictionary.

// apps/api/README.md, error table: the account routes' own errors.
const MESSAGES: Record<string, string> = {
  not_found: "There is no account with this username; it may have been deleted.",
  forbidden: "Only Admins can manage accounts.",
  cannot_revoke_own_admin:
    "You cannot remove Admin from your own account. Ask another Admin to do it.",
  last_admin:
    "This would leave no active Admin, so nothing changed. Make another account Admin first.",
  roles_changed: "Another Admin changed this account's roles just now. Reload and try again.",
  cannot_suspend_self: "You cannot suspend your own account.",
  cannot_delete_self:
    "You cannot delete your own account here. Use Delete account on your profile instead.",
};

/** The /admin/users list's state, as the URL carries it (design doc: "State lives in the URL"). */
export type UsersQuery = { q: string; role?: Role; status?: AccountStatus; page: number };

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Reads /admin/users?q=&role=&status=&page= leniently: an unknown role or a bad page is dropped. */
export function readUsersQuery(params: Params): UsersQuery {
  const q = (first(params.q) ?? "").trim().toLowerCase().slice(0, 254);
  const role = ROLES.find((r) => r === first(params.role));
  const status = ACCOUNT_STATUSES.find((s) => s === first(params.status));
  const n = Number(first(params.page));
  const page = Number.isInteger(n) && n >= 1 ? Math.min(n, 10_000) : 1;
  return { q, role, status, page };
}

function queryString({ q, role, status, page }: UsersQuery): string {
  const sp = new URLSearchParams();
  if (q) sp.set("q", q);
  if (role) sp.set("role", role);
  if (status) sp.set("status", status);
  if (page > 1) sp.set("page", String(page));
  return sp.toString();
}

/** The /admin/users URL for this state; empty filters and page 1 are left out. */
export function usersHref(query: UsersQuery): string {
  const qs = queryString(query);
  return qs ? `/admin/users?${qs}` : "/admin/users";
}

export function userHref(username: string): string {
  return `/admin/users/${encodeURIComponent(username)}`;
}

/** GET /api/admin/users: 20 accounts a page, ordered by username. */
export function listUsers(
  query: UsersQuery,
  signal?: AbortSignal,
): Promise<ApiResult<AdminUserListResponse>> {
  const qs = queryString(query);
  return request(`/api/admin/users${qs ? `?${qs}` : ""}`, AdminUserListResponse, { signal });
}

/** GET /api/admin/users/:username: account fields and which profiles exist. */
export function getUser(
  username: string,
  signal?: AbortSignal,
): Promise<ApiResult<AdminUserDetail>> {
  return request(
    `/api/admin/users/${encodeURIComponent(username)}`,
    AdminUserDetail,
    { signal },
    MESSAGES,
  );
}

/** PUT /api/admin/users/:username/roles: the complete role set (member always included). */
export function setRoles(username: string, roles: Role[]): Promise<ApiResult<AdminUserDetail>> {
  return request(
    `/api/admin/users/${encodeURIComponent(username)}/roles`,
    AdminUserDetail,
    jsonBody("PUT", { roles }),
    MESSAGES,
  );
}

/** PUT /api/admin/users/:username/status: suspend (ends the account's sessions at once) or reactivate. */
export function setStatus(
  username: string,
  status: AccountStatus,
): Promise<ApiResult<AdminUserDetail>> {
  return request(
    `/api/admin/users/${encodeURIComponent(username)}/status`,
    AdminUserDetail,
    jsonBody("PUT", { status }),
    MESSAGES,
  );
}

/** DELETE /api/admin/users/:username: the same cascade as a self-delete; 204. */
export function deleteUser(username: string): Promise<ApiResult<null>> {
  return request(
    `/api/admin/users/${encodeURIComponent(username)}`,
    NO_BODY,
    { method: "DELETE" },
    MESSAGES,
  );
}

/** GET /api/users/me/profiles/admin: the Admin's own counters and private note. */
export function getAdminProfile(signal?: AbortSignal): Promise<ApiResult<AdminProfileView>> {
  return request("/api/users/me/profiles/admin", AdminProfileView, { signal });
}

/** PUT /api/users/me/profiles/admin. */
export function updateAdminProfile(input: AdminProfileInput): Promise<ApiResult<AdminProfileView>> {
  return request("/api/users/me/profiles/admin", AdminProfileView, jsonBody("PUT", input));
}
