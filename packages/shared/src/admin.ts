import { z } from "zod";
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

/** Role profiles a caller can read and edit through /api/users/me/profiles/:kind. */
export const EDITABLE_PROFILE_KINDS = ["curator", "admin"] as const;
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

/** Response of GET and PUT /api/users/me/profiles/:kind. */
export const RoleProfileView = z.discriminatedUnion("kind", [CuratorProfileView, AdminProfileView]);
export type RoleProfileView = z.infer<typeof RoleProfileView>;
