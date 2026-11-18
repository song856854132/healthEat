import { z } from "zod";
import { TimeZone } from "./auth.js";
import { AccountStatus, Role } from "./roles.js";

// Account management for Admins (design doc REST table, D18): Admin manages accounts only and never
// sees an account's logs, allergen settings or the dictionary.

/** Accounts per page of GET /api/admin/users. */
export const ADMIN_USERS_PAGE_SIZE = 20;

/** Query of GET /api/admin/users: `q` matches the start of a username or email, case-insensitive. */
export const AdminUsersQuery = z.object({
  q: z.string().trim().toLowerCase().max(254).optional(),
  role: Role.optional(),
  status: AccountStatus.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export type AdminUsersQuery = z.infer<typeof AdminUsersQuery>;

/** One account as an Admin sees it: account fields only. */
export const AdminUserView = z.object({
  username: z.string(),
  email: z.string(),
  roles: z.array(Role),
  status: AccountStatus,
  activeRole: Role,
  /** True while a deletion that failed part way waits to be finished. */
  deletionPending: z.boolean(),
  createdAt: z.string().datetime(),
});
export type AdminUserView = z.infer<typeof AdminUserView>;

/** Response of GET /api/admin/users, ordered by username. */
export const AdminUserListResponse = z.object({
  users: z.array(AdminUserView),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  total: z.number().int().min(0),
});
export type AdminUserListResponse = z.infer<typeof AdminUserListResponse>;

/**
 * Response of GET /api/admin/users/:username and of the admin writes on one account: the account
 * fields and which role profiles exist (never logs).
 */
export const AdminUserDetail = z.object({
  user: AdminUserView.extend({ privacyAckAt: z.string().datetime().nullable() }),
  profiles: z.object({ member: z.boolean(), curator: z.boolean(), admin: z.boolean() }),
});
export type AdminUserDetail = z.infer<typeof AdminUserDetail>;

/** Body of PUT /api/admin/users/:username/status: suspend or reactivate. */
export const StatusUpdateInput = z.object({ status: AccountStatus });
export type StatusUpdateInput = z.infer<typeof StatusUpdateInput>;

/** Role profiles a caller can read and edit through /api/users/me/profiles/:kind (member since T27). */
export const EDITABLE_PROFILE_KINDS = ["member", "curator", "admin"] as const;
export const EditableProfileKind = z.enum(EDITABLE_PROFILE_KINDS);
export type EditableProfileKind = z.infer<typeof EditableProfileKind>;

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/** Body of PUT /api/users/me/profiles/curator: the Curator's public profile fields. */
export const CuratorProfileInput = z
  .object({
    credentials: optionalText(200),
    bio: optionalText(2000),
    specialties: z
      .array(z.string().trim().min(1).max(40))
      .max(20)
      .refine(
        (s) => new Set(s.map((x) => x.toLowerCase())).size === s.length,
        "specialties must not repeat",
      )
      .optional(),
    publicListing: z.boolean().optional(),
  })
  .strict();
export type CuratorProfileInput = z.infer<typeof CuratorProfileInput>;

/** A CuratorProfile as its owner reads it. `editsCount` and `lastEditAt` are counted by the server. */
export const CuratorProfileView = z.object({
  kind: z.literal("curator"),
  credentials: z.string().nullable(),
  bio: z.string().nullable(),
  specialties: z.array(z.string()),
  publicListing: z.boolean(),
  editsCount: z.number().int().min(0),
  lastEditAt: z.string().datetime().nullable(),
});
export type CuratorProfileView = z.infer<typeof CuratorProfileView>;

/** Body of PUT /api/users/me/profiles/admin: the Admin's private note. */
export const AdminProfileInput = z.object({ internalNote: optionalText(2000) }).strict();
export type AdminProfileInput = z.infer<typeof AdminProfileInput>;

/** An AdminProfile as its owner reads it. `grantsCount` and `lastAuditAt` are counted by the server. */
export const AdminProfileView = z.object({
  kind: z.literal("admin"),
  grantsCount: z.number().int().min(0),
  lastAuditAt: z.string().datetime().nullable(),
  internalNote: z.string().nullable(),
});
export type AdminProfileView = z.infer<typeof AdminProfileView>;

export const SEXES = ["female", "male", "unspecified"] as const;
export const ACTIVITY_LEVELS = ["sedentary", "light", "moderate", "active", "very_active"] as const;

/** A daily calorie band in kcal; `low` is never above `high`. */
export const CalorieBand = z
  .object({ low: z.number().int().min(0).max(10000), high: z.number().int().min(0).max(10000) })
  .strict()
  .refine((b) => b.low <= b.high, "calorieBand.low must not be above calorieBand.high");
export type CalorieBand = z.infer<typeof CalorieBand>;

const currentYear = () => new Date().getUTCFullYear();

/**
 * Body of PUT /api/users/me/profiles/member (T27). Absent fields stay as they are; null (or "" for the
 * phone) clears an optional field. `sex`, `activityLevel` and `timezone` have defaults the rest of the
 * API relies on, so they can be changed but never cleared. `driSetKey` is derived from sex and age by
 * the summary (T25), never set here.
 */
export const MemberProfileInput = z
  .object({
    sex: z.enum(SEXES).optional(),
    birthYear: z
      .number()
      .int()
      .min(1900)
      .refine((y) => y <= currentYear(), "birthYear is in the future")
      .nullable()
      .optional(),
    heightCm: z.number().min(50).max(272).nullable().optional(),
    weightKg: z.number().min(20).max(500).nullable().optional(),
    activityLevel: z.enum(ACTIVITY_LEVELS).optional(),
    calorieBand: CalorieBand.nullable().optional(),
    timezone: TimeZone.optional(),
    publicLogs: z.boolean().optional(),
    showPhoneOnProfile: z.boolean().optional(),
    phone: z
      .string()
      .trim()
      .max(32)
      .regex(/^$|^\+?[0-9 ()-]{3,32}$/, "digits, spaces, (), - and a leading +")
      .nullable()
      .optional(),
  })
  .strict();
export type MemberProfileInput = z.infer<typeof MemberProfileInput>;

/** A MemberProfile as its owner reads it. `visionUsage` is server-written and not shown. */
export const MemberProfileView = z.object({
  kind: z.literal("member"),
  sex: z.enum(SEXES),
  birthYear: z.number().int().nullable(),
  heightCm: z.number().nullable(),
  weightKg: z.number().nullable(),
  activityLevel: z.enum(ACTIVITY_LEVELS),
  calorieBand: z.object({ low: z.number(), high: z.number() }).nullable(),
  timezone: z.string(),
  publicLogs: z.boolean(),
  showPhoneOnProfile: z.boolean(),
  phone: z.string().nullable(),
});
export type MemberProfileView = z.infer<typeof MemberProfileView>;

/** Response of GET and PUT /api/users/me/profiles/:kind. */
export const RoleProfileView = z.discriminatedUnion("kind", [
  MemberProfileView,
  CuratorProfileView,
  AdminProfileView,
]);
export type RoleProfileView = z.infer<typeof RoleProfileView>;

/**
 * Body of PUT /api/users/me (T27): the account fields a member may change. The username is immutable
 * (the route answers 400 username_immutable when one is sent); the timezone lives on the member profile.
 */
export const AccountUpdateInput = z
  .object({ email: z.string().trim().toLowerCase().pipe(z.email().max(254)) })
  .strict();
export type AccountUpdateInput = z.infer<typeof AccountUpdateInput>;

/**
 * Response of GET /api/users/:username (T27; design doc REST table "public profile, sensitive fields
 * stripped unless self"). Admin profiles are never public. `private` is present only when the caller
 * is that account.
 */
export const PublicProfileView = z.object({
  username: z.string(),
  roles: z.array(z.string()),
  memberSince: z.string().datetime(),
  curator: z
    .object({
      credentials: z.string().nullable(),
      bio: z.string().nullable(),
      specialties: z.array(z.string()),
    })
    .nullable(),
  phone: z.string().nullable(),
  self: z.boolean(),
  private: z.object({ email: z.string(), member: MemberProfileView }).nullable(),
});
export type PublicProfileView = z.infer<typeof PublicProfileView>;
