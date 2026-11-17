import type {
  AccountStatus,
  AdminUserDetail,
  AdminUserListResponse,
  AdminUsersQuery,
  AdminUserView,
} from "@healtheat/shared";
import { ADMIN_USERS_PAGE_SIZE } from "@healtheat/shared";
import type { Types } from "mongoose";
import { HttpError } from "../lib/http.js";
import { AdminProfile, CuratorProfile, MemberProfile, User } from "../models/index.js";
import type { UserDoc } from "../models/User.js";
import { deleteAccount, deleteSessions } from "./account.js";
import { usableAdminCount } from "./roles.js";

// Account management for Admins (design doc REST table, D18). An Admin sees account fields and which
// role profiles exist, never logs, allergen settings or the dictionary. Every change an Admin makes
// counts on their own AdminProfile (`grantsCount`, `lastAuditAt`), like role changes (services/roles.ts).

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type AccountFields = Pick<
  UserDoc,
  "username" | "email" | "roles" | "status" | "activeRole" | "deletionPending" | "createdAt"
>;

const view = (u: AccountFields): AdminUserView => ({
  username: u.username,
  email: u.email,
  roles: [...u.roles] as AdminUserView["roles"],
  status: u.status as AdminUserView["status"],
  activeRole: u.activeRole as AdminUserView["activeRole"],
  deletionPending: u.deletionPending === true,
  createdAt: u.createdAt.toISOString(),
});

/** GET /api/admin/users: accounts by username, filtered by role, status and a username or email prefix. */
export async function listUsers(query: AdminUsersQuery): Promise<AdminUserListResponse> {
  const filter: Record<string, unknown> = {};
  if (query.role) filter.roles = query.role;
  if (query.status) filter.status = query.status;
  if (query.q) {
    // Stored usernames and emails are lowercase and the query is lowercased, so an anchored prefix
    // regex can use the unique indexes.
    const prefix = new RegExp(`^${escapeRegex(query.q)}`);
    filter.$or = [{ username: prefix }, { email: prefix }];
  }
  const [users, total] = await Promise.all([
    User.find(filter)
      .sort({ username: 1 })
      .skip((query.page - 1) * ADMIN_USERS_PAGE_SIZE)
      .limit(ADMIN_USERS_PAGE_SIZE)
      .lean(),
    User.countDocuments(filter),
  ]);
  return {
    users: users.map((u) => view(u as unknown as AccountFields)),
    page: query.page,
    pageSize: ADMIN_USERS_PAGE_SIZE,
    total,
  };
}

/** The account a URL names, or 404 not_found. Usernames are stored lowercase. */
export async function findAccount(username: string): Promise<UserDoc> {
  const user = await User.findOne({ username: username.toLowerCase() });
  if (!user) throw new HttpError(404, "not_found");
  return user;
}

/** GET /api/admin/users/:username and the answer of the Admin writes on one account. */
export async function userDetail(user: UserDoc): Promise<AdminUserDetail> {
  const [member, curator, admin] = await Promise.all([
    MemberProfile.exists({ userId: user._id }),
    CuratorProfile.exists({ userId: user._id }),
    AdminProfile.exists({ userId: user._id }),
  ]);
  return {
    user: { ...view(user), privacyAckAt: user.privacyAckAt?.toISOString() ?? null },
    profiles: { member: member !== null, curator: curator !== null, admin: admin !== null },
  };
}

async function countChange(actorId: Types.ObjectId): Promise<void> {
  await AdminProfile.updateOne(
    { userId: actorId },
    { $inc: { grantsCount: 1 }, $set: { lastAuditAt: new Date() } },
    { upsert: true },
  );
}

/**
 * PUT /api/admin/users/:username/status: suspend or reactivate. A suspended account cannot log in, and
 * its sessions are ended here (requireAuth would also refuse them on their next request). Lockout
 * guards, as for role changes: an Admin cannot suspend themselves (409 cannot_suspend_self), and no
 * suspension may leave the deployment without a usable Admin (409 last_admin), checked before the write
 * and again after it, so two Admins suspending each other at once cannot both succeed.
 */
export async function setStatus(
  actor: UserDoc,
  target: UserDoc,
  status: AccountStatus,
): Promise<void> {
  if (target.status === status) return;
  if (status === "suspended") {
    if (actor._id.equals(target._id)) throw new HttpError(409, "cannot_suspend_self");
    const isAdmin = target.roles.includes("admin");
    if (isAdmin && (await usableAdminCount(target._id)) === 0)
      throw new HttpError(409, "last_admin");
    await User.updateOne({ _id: target._id }, { $set: { status } });
    if (isAdmin && (await usableAdminCount()) === 0) {
      await User.updateOne({ _id: target._id }, { $set: { status: "active" } });
      throw new HttpError(409, "last_admin");
    }
    await deleteSessions(target._id);
  } else {
    await User.updateOne({ _id: target._id }, { $set: { status } });
  }
  target.status = status;
  target.unmarkModified("status");
  await countChange(actor._id);
}

/**
 * DELETE /api/admin/users/:username: the same cascade as self-delete (services/account.ts, T5). An
 * Admin deletes their own account through DELETE /api/users/me (409 cannot_delete_self here), and the
 * last usable Admin cannot be deleted (409 last_admin). A cascade that fails part way is retried once;
 * a second failure leaves the account locked with `deletionPending`, and another DELETE finishes it.
 */
export async function deleteUser(actor: UserDoc, target: UserDoc): Promise<void> {
  if (actor._id.equals(target._id)) throw new HttpError(409, "cannot_delete_self");
  try {
    await deleteAccount(target._id, { keepAnAdmin: true });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    await deleteAccount(target._id, { keepAnAdmin: true });
  }
  await countChange(actor._id);
}
