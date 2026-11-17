import type {
  AdminProfileInput,
  CuratorProfileInput,
  EditableProfileKind,
  RoleProfileView,
} from "@healtheat/shared";
import { HttpError } from "../lib/http.js";
import { AdminProfile, CuratorProfile } from "../models/index.js";
import type { UserDoc } from "../models/User.js";

// GET and PUT /api/users/me/profiles/:kind (design doc, Role rules): a caller reads and edits the
// profile of a role they hold. The counters (`editsCount`, `lastEditAt`, `grantsCount`, `lastAuditAt`)
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

export async function getProfile(
  user: UserDoc,
  kind: EditableProfileKind,
): Promise<RoleProfileView> {
  requireHeld(user, kind);
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
  input: CuratorProfileInput | AdminProfileInput,
): Promise<RoleProfileView> {
  requireHeld(user, kind);
  const { $set, $unset } = changes(input);
  const update = {
    $setOnInsert: { userId: user._id },
    ...(Object.keys($set).length > 0 ? { $set } : {}),
    ...(Object.keys($unset).length > 0 ? { $unset } : {}),
  };
  const opts = { upsert: true, runValidators: true };
  if (kind === "curator") await CuratorProfile.updateOne({ userId: user._id }, update, opts);
  else await AdminProfile.updateOne({ userId: user._id }, update, opts);
  return getProfile(user, kind);
}
