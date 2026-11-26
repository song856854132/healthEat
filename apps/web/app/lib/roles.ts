import { MeResponse, ROLES } from "@healtheat/shared";
import type { Role } from "@healtheat/shared";
import { jsonBody, request } from "./request";
import type { ApiResult } from "./request";

// Roles in the web app (design doc D18, R3-7): every account is a member; Curator and Admin are granted.
// The active role picks which Home and which nav links show; it never grants or refuses a route.

export const ROLE_LABELS: Record<Role, string> = {
  member: "Member",
  curator: "Curator",
  admin: "Admin",
};

/** An account's roles in the canonical order (member, curator, admin), whatever order they came in. */
export function orderedRoles(roles: readonly Role[]): Role[] {
  return ROLES.filter((r) => roles.includes(r));
}

/** PUT /api/users/me/active-role: switch the view; answers the updated account. */
export function setActiveRole(role: Role): Promise<ApiResult<MeResponse>> {
  return request("/api/users/me/active-role", MeResponse, jsonBody("PUT", { role }));
}
