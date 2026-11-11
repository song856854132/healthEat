import { z } from "zod";

export { ROLES, Role, ACCOUNT_STATUSES, AccountStatus } from "./roles.js";

export const DB_STATES = [
  "connected",
  "connecting",
  "disconnected",
  "unconfigured",
  "misconfigured",
] as const;
export const DbState = z.enum(DB_STATES);
export type DbState = z.infer<typeof DbState>;

/** Response of GET /api/health. Shared between the Express API and the Next.js web app. */
export const HealthResponse = z.object({
  ok: z.literal(true),
  service: z.literal("healtheat-api"),
  version: z.string(),
  commit: z.string(),
  env: z.enum(["local", "development", "preview", "production"]),
  db: DbState,
  dbName: z.string().nullable(),
  secrets: z.enum(["ok", "missing"]),
  now: z.string().datetime(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/** Response of GET /api/spike/whoami (proxy + cookie spike, plan task T1). */
export const WhoAmI = z.object({ name: z.string().nullable() });
export type WhoAmI = z.infer<typeof WhoAmI>;

export const APP_NAME = "healthEat";

export * from "./auth.js";
