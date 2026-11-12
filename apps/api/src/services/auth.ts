import type { LoginInput, MeResponse, RegisterInput } from "@healtheat/shared";
import { HttpError } from "../lib/http.js";
import { DUMMY_HASH, hashPassword, verifyPassword } from "../lib/password.js";
import { AdminProfile, CuratorProfile, MemberProfile, User } from "../models/index.js";
import type { UserDoc } from "../models/User.js";
import { accountBlocked } from "../middleware/auth.js";
import { applyAdminBootstrap } from "./roles.js";

// Indexes are built by Mongoose when the connection opens, but `bufferCommands: false` lets a create()
// race the build; waiting on init() once makes a duplicate username a deterministic 409, never a
// second document.
// A rejected promise is forgotten so the next request retries (mirrors db.ts); a cached rejection would
// turn one transient index failure into a 5xx on every later register() of this warm instance.
let indexesReady: Promise<unknown> | undefined;
const ensureIndexes = () =>
  (indexesReady ??= Promise.all([User.createIndexes(), MemberProfile.createIndexes()]).catch(
    (err: unknown) => {
      indexesReady = undefined;
      throw err;
    },
  ));

/**
 * Create the account and its member profile. The two writes are not atomic (no transactions on M0):
 * a failed profile write removes the user again so the username is not burned, and both steps are
 * rerunnable. Duplicate username or email surfaces as the driver's 11000, mapped to 409 by error.ts.
 */
export async function register(
  input: RegisterInput,
  privacyAcknowledged: boolean,
): Promise<UserDoc> {
  await ensureIndexes();
  const passwordHash = await hashPassword(input.password);
  const user = await User.create({
    username: input.username,
    email: input.email,
    passwordHash,
    privacyAckAt: privacyAcknowledged ? new Date() : undefined,
  });
  try {
    await MemberProfile.create({ userId: user._id, timezone: input.timezone });
  } catch (err) {
    await User.deleteOne({ _id: user._id }).catch(() => undefined);
    throw err;
  }
  await applyAdminBootstrap(user);
  return user;
}

/**
 * Verify credentials. Unknown username and wrong password both cost one bcrypt compare and both
 * answer the same 401 `invalid_credentials`; account status is only revealed after the password matched.
 */
export async function login(input: LoginInput): Promise<UserDoc> {
  const user = await User.findOne({ username: input.username }).select("+passwordHash");
  const ok = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, "invalid_credentials");
  const blocked = accountBlocked(user);
  if (blocked) throw blocked;
  await applyAdminBootstrap(user);
  return user;
}

/** Record the privacy-banner acknowledgment on the account once (design doc, Privacy policy on first visit). */
export async function acknowledgePrivacy(user: UserDoc): Promise<void> {
  if (user.privacyAckAt) return;
  user.privacyAckAt = new Date();
  await user.save();
}

/** Switch the Home the account renders; the role must already be held (design doc, Role rules). */
export async function setActiveRole(user: UserDoc, role: MeResponse["user"]["activeRole"]) {
  if (!user.roles.includes(role)) throw new HttpError(403, "forbidden", "role not held");
  user.activeRole = role;
  await user.save();
}

export async function me(user: UserDoc): Promise<MeResponse> {
  const [member, curator, admin] = await Promise.all([
    MemberProfile.exists({ userId: user._id }),
    CuratorProfile.exists({ userId: user._id }),
    AdminProfile.exists({ userId: user._id }),
  ]);
  return {
    user: {
      username: user.username,
      email: user.email,
      roles: [...user.roles],
      status: user.status,
      activeRole: user.activeRole,
      privacyAckAt: user.privacyAckAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
    },
    profiles: { member: member !== null, curator: curator !== null, admin: admin !== null },
  };
}
