import { z } from "zod";

/** Account roles (design doc D18): every account is a member; curator and admin are granted. */
export const ROLES = ["member", "curator", "admin"] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

export const ACCOUNT_STATUSES = ["active", "suspended"] as const;
export const AccountStatus = z.enum(ACCOUNT_STATUSES);
export type AccountStatus = z.infer<typeof AccountStatus>;
