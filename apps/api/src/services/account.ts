import mongoose, { type Types } from "mongoose";
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

/**
 * Deletes the account and everything it owns: log entries, allergen settings, the three role profiles
 * and its sessions, then the User. Safe to call again on an account that is half deleted or gone.
 */
export async function deleteAccount(userId: Types.ObjectId): Promise<void> {
  await User.updateOne({ _id: userId }, { $set: { deletionPending: true } });
  await LogEntry.deleteMany({ userId });
  await UserAllergen.deleteMany({ userId });
  await MemberProfile.deleteMany({ userId });
  await CuratorProfile.deleteMany({ userId });
  await AdminProfile.deleteMany({ userId });
  // connect-mongo stores sessions as native documents (lib/session.ts, stringify: false) in this database.
  await mongoose.connection
    .db!.collection("sessions")
    .deleteMany({ "session.userId": String(userId) });
  await User.deleteOne({ _id: userId });
}
