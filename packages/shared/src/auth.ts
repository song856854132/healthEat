import { z } from "zod";
import { Role, AccountStatus } from "./roles.js";

/** Rubric: username is immutable and unique; lowercase letters, digits and underscore, 3 to 24 chars. */
export const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;

/** Session cookie (express-session) and the privacy-banner acknowledgment cookie (design doc, Privacy). */
export const SESSION_COOKIE = "he_sid";
export const PRIVACY_ACK_COOKIE = "he_privacy_ack";

// bcrypt reads at most 72 bytes of a password; longer input is accepted but silently truncated, so
// the cap below is a request-size guard, not a strength rule. PASSWORD_MIN_LENGTH is the real rule.
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

/**
 * True when the runtime knows the IANA time zone. Deliberately not `Intl.supportedValuesOf`: that
 * list omits "UTC" (which browsers do report) and legacy aliases such as "Asia/Calcutta"; the
 * DateTimeFormat constructor accepts every zone the runtime can actually compute dates in.
 */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Canonical spelling of a valid zone ("utc" -> "UTC", "Asia/Calcutta" stays as the runtime resolves it). */
export function canonicalTimeZone(tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
}

const TimeZone = z
  .string()
  .trim()
  .min(1, "timezone is required")
  .max(64)
  .refine(isValidTimeZone, "unknown IANA time zone")
  .transform(canonicalTimeZone);

/** Body of POST /api/auth/register. The web form reuses it for client-side validation. */
export const RegisterInput = z.object({
  username: z.string().trim().toLowerCase().regex(USERNAME_PATTERN, {
    message: "3 to 24 characters: lowercase letters, digits and underscore",
  }),
  // trim/lowercase first, then the format check: zod 4 runs z.email()'s pattern before chained checks.
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  timezone: TimeZone,
});
export type RegisterInput = z.infer<typeof RegisterInput>;

/** Body of POST /api/auth/login. No pattern check: a wrong shape gets the same generic 401 as a wrong password. */
export const LoginInput = z.object({
  username: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginInput = z.infer<typeof LoginInput>;

/** Body of PUT /api/users/me/active-role. */
export const ActiveRoleInput = z.object({ role: Role });
export type ActiveRoleInput = z.infer<typeof ActiveRoleInput>;

/** Response of GET /api/auth/me, POST /api/auth/register and POST /api/auth/login. */
export const MeResponse = z.object({
  user: z.object({
    username: z.string(),
    email: z.string(),
    roles: z.array(Role),
    status: AccountStatus,
    activeRole: Role,
    privacyAckAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  }),
  // Which role profiles exist for this account (design doc R3: granting a role upserts its profile).
  profiles: z.object({ member: z.boolean(), curator: z.boolean(), admin: z.boolean() }),
});
export type MeResponse = z.infer<typeof MeResponse>;
