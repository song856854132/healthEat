import type { Role } from "@healtheat/shared";
import { adminUsernames } from "../lib/env.js";
import { HttpError } from "../lib/http.js";
import { AdminProfile, CuratorProfile, User } from "../models/index.js";
import type { UserDoc } from "../models/User.js";

// Design doc R3-5 / R3-8 / D10: granting a role upserts that role's (empty) profile document; revoking
// keeps the profile and, when the revoked role was the active view, resets `activeRole` to member. The
// session follows on the account's next request (middleware/auth.ts loadUser copies User.activeRole).
// `member` is never granted or revoked here: every account holds it and its profile is made at register.
//
// Role writes are atomic conditional updates, never load-mutate-save: two admins editing one account
// at once cannot duplicate a role or silently drop the other's change (the loser gets 409
// roles_changed and retries). Profiles are upserted only after the role write succeeded, so a failed
// write never leaves a profile for a role the account does not hold.

async function ensureProfile(user: UserDoc, role: Role): Promise<void> {
  // $setOnInsert on the unique userId index: idempotent, and a concurrent grant cannot create two.
  const filter = { userId: user._id };
  const update = { $setOnInsert: { userId: user._id } };
  if (role === "curator") await CuratorProfile.updateOne(filter, update, { upsert: true });
  if (role === "admin") await AdminProfile.updateOne(filter, update, { upsert: true });
}

/** Copy the stored role fields into an already-loaded document without marking them for a later save. */
function syncRoles(user: UserDoc, roles: Role[], activeRole: Role): void {
  user.roles = roles;
  user.activeRole = activeRole;
  user.unmarkModified("roles");
  user.unmarkModified("activeRole");
}

const adminCount = (excluding?: UserDoc) =>
  User.countDocuments({ roles: "admin", ...(excluding ? { _id: { $ne: excluding._id } } : {}) });

/**
 * An admin sets `target`'s complete role set (always containing `member`). Returns the number of roles
 * granted plus revoked; the acting admin's AdminProfile counts them (`grantsCount`, `lastAuditAt`).
 *
 * Lockout guards: an admin cannot remove their own `admin` (409 cannot_revoke_own_admin), and no change
 * may leave the deployment without an admin (409 last_admin). The second guard checks before the write
 * and again after it, undoing the revoke if two admins demoted each other at the same moment; a listed
 * ADMIN_USERNAMES account is the recovery path of last resort.
 */
export async function setRoles(actor: UserDoc, target: UserDoc, roles: Role[]): Promise<number> {
  if (actor._id.equals(target._id) && !roles.includes("admin")) {
    throw new HttpError(409, "cannot_revoke_own_admin");
  }
  const current = [...target.roles] as Role[];
  const granted = roles.filter((r) => !current.includes(r));
  const revoked = current.filter((r) => r !== "member" && !roles.includes(r));
  if (granted.length === 0 && revoked.length === 0) return 0;
  const revokesAdmin = revoked.includes("admin");
  if (revokesAdmin && (await adminCount(target)) === 0) throw new HttpError(409, "last_admin");

  const next = [...current.filter((r) => !revoked.includes(r)), ...granted];
  const activeRole: Role = next.includes(target.activeRole as Role)
    ? (target.activeRole as Role)
    : "member";
  // Matches only if the stored roles are still exactly what this request read.
  const written = await User.updateOne(
    { _id: target._id, roles: current },
    { $set: { roles: next, activeRole } },
  );
  if (written.matchedCount === 0) throw new HttpError(409, "roles_changed");

  if (revokesAdmin && (await adminCount()) === 0) {
    // Lost a race with another demotion: put this account's admin role back and refuse.
    await User.updateOne({ _id: target._id }, { $addToSet: { roles: "admin" } });
    throw new HttpError(409, "last_admin");
  }
  for (const role of granted) await ensureProfile(target, role);
  syncRoles(target, next, activeRole);
  const changes = granted.length + revoked.length;
  await AdminProfile.updateOne(
    { userId: actor._id },
    { $inc: { grantsCount: changes }, $set: { lastAuditAt: new Date() } },
    { upsert: true },
  );
  return changes;
}

/** D10 bootstrap: a username listed in ADMIN_USERNAMES holds `admin`, granted at register and login. */
export async function applyAdminBootstrap(user: UserDoc): Promise<void> {
  if (!adminUsernames().has(user.username)) return;
  // Atomic: a concurrent bootstrap or grant cannot add `admin` twice.
  const written = await User.updateOne(
    { _id: user._id, roles: { $ne: "admin" } },
    { $push: { roles: "admin" } },
  );
  if (written.modifiedCount === 1 || !user.roles.includes("admin")) {
    await ensureProfile(user, "admin");
    syncRoles(
      user,
      [...(user.roles as Role[]).filter((r) => r !== "admin"), "admin"],
      user.activeRole as Role,
    );
  }
}
