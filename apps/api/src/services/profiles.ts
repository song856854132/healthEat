import type {
  AccountUpdateInput,
  AdminProfileInput,
  CuratorProfileInput,
  EditableProfileKind,
  MemberProfileInput,
  MemberProfileView,
  PublicProfileView,
  RoleProfileView,
} from "@healtheat/shared";
import { HttpError } from "../lib/http.js";
import { AdminProfile, CuratorProfile, MemberProfile, User } from "../models/index.js";
import type { UserDoc } from "../models/User.js";

// GET and PUT /api/users/me/profiles/:kind (design doc, Role rules): a caller reads and edits the
// profile of a role they hold; every account holds member (T27). The counters (`editsCount`, `lastEditAt`, `grantsCount`, `lastAuditAt`)
// are written by the server only. A profile is upserted at grant (services/roles.ts); one missing for
// any other reason is created on the first edit and read as empty until then.

function requireHeld(user: UserDoc, kind: EditableProfileKind) {
  if (!user.roles.includes(kind)) throw new HttpError(403, "forbidden", "role not held");
}

const iso = (d?: Date | null) => d?.toISOString() ?? null;

/** Splits an edit into fields to set and fields to clear (sent as null); absent fields stay as they are. */
function changes(input: Record<string, unknown>) {
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, ""> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (v === null || v === "") $unset[k] = "";
    else $set[k] = v;
  }
  return { $set, $unset };
}

type StoredMember = {
  sex?: string | null;
  birthYear?: number | null;
  heightCm?: number | null;
  weightKg?: number | null;
  activityLevel?: string | null;
  calorieBand?: { low?: number | null; high?: number | null } | null;
  timezone?: string | null;
  publicLogs?: boolean | null;
  showPhoneOnProfile?: boolean | null;
  phone?: string | null;
};

const band = (b: StoredMember["calorieBand"]) =>
  typeof b?.low === "number" && typeof b.high === "number" ? { low: b.low, high: b.high } : null;

/** A MemberProfile as its owner reads it; a missing document reads as the schema defaults. */
export function memberView(p: StoredMember | null | undefined): MemberProfileView {
  return {
    kind: "member",
    sex: (p?.sex ?? "unspecified") as MemberProfileView["sex"],
    birthYear: p?.birthYear ?? null,
    heightCm: p?.heightCm ?? null,
    weightKg: p?.weightKg ?? null,
    activityLevel: (p?.activityLevel ?? "light") as MemberProfileView["activityLevel"],
    calorieBand: band(p?.calorieBand),
    timezone: p?.timezone ?? "UTC",
    publicLogs: p?.publicLogs ?? false,
    showPhoneOnProfile: p?.showPhoneOnProfile ?? false,
    phone: p?.phone ?? null,
  };
}

export async function getProfile(
  user: UserDoc,
  kind: EditableProfileKind,
): Promise<RoleProfileView> {
  requireHeld(user, kind);
  if (kind === "member") return memberView(await MemberProfile.findOne({ userId: user._id }).lean());
  if (kind === "curator") {
    const p = await CuratorProfile.findOne({ userId: user._id }).lean();
    return {
      kind,
      credentials: p?.credentials ?? null,
      bio: p?.bio ?? null,
      specialties: p?.specialties ?? [],
      publicListing: p?.publicListing ?? false,
      editsCount: p?.editsCount ?? 0,
      lastEditAt: iso(p?.lastEditAt),
    };
  }
  const p = await AdminProfile.findOne({ userId: user._id }).lean();
  return {
    kind,
    grantsCount: p?.grantsCount ?? 0,
    lastAuditAt: iso(p?.lastAuditAt),
    internalNote: p?.internalNote ?? null,
  };
}

export async function updateProfile(
  user: UserDoc,
  kind: EditableProfileKind,
  input: MemberProfileInput | CuratorProfileInput | AdminProfileInput,
): Promise<RoleProfileView> {
  requireHeld(user, kind);
  const { $set, $unset } = changes(input);
  const update = {
    $setOnInsert: { userId: user._id },
    ...(Object.keys($set).length > 0 ? { $set } : {}),
    ...(Object.keys($unset).length > 0 ? { $unset } : {}),
  };
  const opts = { upsert: true, runValidators: true };
  if (kind === "member") await MemberProfile.updateOne({ userId: user._id }, update, opts);
  else if (kind === "curator") await CuratorProfile.updateOne({ userId: user._id }, update, opts);
  else await AdminProfile.updateOne({ userId: user._id }, update, opts);
  return getProfile(user, kind);
}

/**
 * PUT /api/users/me (T27): the account fields a member may change, today the email. A taken email is the
 * unique index's duplicate key error, answered 409 conflict by the error middleware.
 */
export async function updateAccount(user: UserDoc, input: AccountUpdateInput): Promise<void> {
  await User.updateOne({ _id: user._id }, { $set: { email: input.email } }, { runValidators: true });
}

/**
 * GET /api/users/:username (T27; design doc REST table): public fields for anyone; the email and the
 * member profile only for the account itself (`viewerId`). Suspended accounts and accounts being deleted
 * are 404, so a public profile never outlives its account. The phone shows only with
 * `showPhoneOnProfile`; the Admin profile is never public.
 */
export async function publicProfile(
  username: string,
  viewerId: string | null,
): Promise<PublicProfileView> {
  const user = await User.findOne({ username: username.toLowerCase() }).lean();
  if (!user || user.status !== "active" || user.deletionPending)
    throw new HttpError(404, "user_not_found");
  const self = viewerId !== null && viewerId === String(user._id);
  const [member, curator] = await Promise.all([
    MemberProfile.findOne({ userId: user._id }).lean(),
    user.roles.includes("curator") ? CuratorProfile.findOne({ userId: user._id }).lean() : null,
  ]);
  return {
    username: user.username,
    roles: [...user.roles],
    memberSince: (user.createdAt as Date).toISOString(),
    curator: user.roles.includes("curator")
      ? {
          credentials: curator?.credentials ?? null,
          bio: curator?.bio ?? null,
          specialties: curator?.specialties ?? [],
        }
      : null,
    phone: member?.showPhoneOnProfile ? (member.phone ?? null) : null,
    self,
    private: self ? { email: user.email, member: memberView(member) } : null,
  };
}

