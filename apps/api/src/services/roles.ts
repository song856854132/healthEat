import type { Role } from "@healtheat/shared";
import { adminUsernames } from "../lib/env.js";
import { HttpError } from "../lib/http.js";
import { AdminProfile, CuratorProfile } from "../models/index.js";
import type { UserDoc } from "../models/User.js";

// Design doc R3-5 / R3-8 / D10: granting a role upserts that role's (empty) profile document; revoking
// keeps the profile and, when the revoked role was the active view, resets `activeRole` to member. The
// session follows on the account's next request (middleware/auth.ts loadUser copies User.activeRole).
// `member` is never granted or revoked here: every account holds it and its profile is made at register.

async function ensureProfile(user: UserDoc, role: Role): Promise<void> {
  // $setOnInsert on the unique userId index: idempotent, and a concurrent grant cannot create two.
  const filter = { userId: user._id };
  const update = { $setOnInsert: { userId: user._id } };
  if (role === "curator") await CuratorProfile.updateOne(filter, update, { upsert: true });
  if (role === "admin") await AdminProfile.updateOne(filter, update, { upsert: true });
}

/** Add `role` to the account (unsaved) and upsert its profile. Returns false when already held. */
export async function grantRole(user: UserDoc, role: Role): Promise<boolean> {
  if (user.roles.includes(role)) return false;
  await ensureProfile(user, role);
  user.roles.push(role);
  return true;
}

/** Remove `role` from the account (unsaved); the profile is retained. Returns false when not held. */
export function revokeRole(user: UserDoc, role: Role): boolean {
  if (role === "member" || !user.roles.includes(role)) return false;
  user.roles = user.roles.filter((r) => r !== role);
  if (user.activeRole === role) user.activeRole = "member";
  return true;
}

/**
 * An admin sets `target`'s complete role set. Changes are applied and saved once; the acting admin's
 * AdminProfile counts them (`grantsCount`, `lastAuditAt`). An admin cannot remove their own `admin`
 * role, so the last admin can never lock everyone out.
 */
export async function setRoles(actor: UserDoc, target: UserDoc, roles: Role[]): Promise<number> {
  if (actor._id.equals(target._id) && !roles.includes("admin")) {
    throw new HttpError(409, "cannot_revoke_own_admin");
  }
  let changes = 0;
  for (const role of roles) if (await grantRole(target, role)) changes += 1;
  for (const role of [...target.roles])
    if (!roles.includes(role) && revokeRole(target, role)) changes += 1;
  if (changes === 0) return 0;
  await target.save();
  await AdminProfile.updateOne(
    { userId: actor._id },
    { $inc: { grantsCount: changes }, $set: { lastAuditAt: new Date() } },
    { upsert: true },
  );
  return changes;
}

/** D10 bootstrap: a username listed in ADMIN_USERNAMES holds `admin`, granted (and saved) at register and login. */
export async function applyAdminBootstrap(user: UserDoc): Promise<void> {
  if (!adminUsernames().has(user.username)) return;
  if (await grantRole(user, "admin")) await user.save();
}
