import mongoose, { type Types } from "mongoose";
import { HttpError } from "../lib/http.js";
import { usableAdminCount } from "./roles.js";
import {
  AdminProfile,
  CuratorProfile,
  LogEntry,
  MemberProfile,
  User,
  UserAllergen,
} from "../models/index.js";

// Account deletion (design doc D6, Working plan amendments: multi-document writes). One cascade for
// self-delete (DELETE /api/users/me) and Admin delete (T21). No transaction on the M0 tier: the flag
// goes first, so a half-deleted account can never log in or use a session (requireAuth and login refuse
// `deletionPending`), then the member's data, then the User. Every step is a plain delete by userId, so
// a rerun after a crash converges. SymptomEntry joins the list when it exists (phase 3).

/** Ends every session of the account (logout everywhere). */
export async function deleteSessions(userId: Types.ObjectId): Promise<void> {
  // connect-mongo stores sessions as native documents (lib/session.ts, stringify: false) in this database.
  await mongoose.connection
    .db!.collection("sessions")
    .deleteMany({ "session.userId": String(userId) });
}

/**
 * Deletes the account and everything it owns: log entries, allergen settings, the three role profiles
 * and its sessions, then the User. Safe to call again on an account that is half deleted or gone.
 *
 * `keepAnAdmin` (self-delete and its retries): an Admin is refused with 409 last_admin when no other
 * usable Admin remains (roles.ts usableAdminCount, the same count as role changes). It is checked before
 * the flag and again after it; a refusal clears the flag, so two last Admins deleting themselves at the
 * same moment cannot both go, and a flagged last Admin gets their account back.
 */
export async function deleteAccount(
  userId: Types.ObjectId,
  { keepAnAdmin = false }: { keepAnAdmin?: boolean } = {},
): Promise<void> {
  const isAdmin = keepAnAdmin && (await User.exists({ _id: userId, roles: "admin" })) !== null;
  const lastAdmin = async () => isAdmin && (await usableAdminCount(userId)) === 0;
  const refuse = async () => {
    // The deletion is called off: clear a flag an earlier failed attempt may have left.
    await User.updateOne({ _id: userId }, { $set: { deletionPending: false } });
    throw new HttpError(409, "last_admin");
  };
  if (await lastAdmin()) await refuse();
  await User.updateOne({ _id: userId }, { $set: { deletionPending: true } });
  if (await lastAdmin()) await refuse();
  const sweepMemberData = async () => {
    await LogEntry.deleteMany({ userId });
    await UserAllergen.deleteMany({ userId });
  };
  await sweepMemberData();
  await MemberProfile.deleteMany({ userId });
  await CuratorProfile.deleteMany({ userId });
  await AdminProfile.deleteMany({ userId });
  await deleteSessions(userId);
  await User.deleteOne({ _id: userId });
  // A log or setting write that passed requireAuth before the flag can land after its deleteMany;
  // once the User is gone nothing could rerun the cascade, so sweep once more.
  await sweepMemberData();
}
