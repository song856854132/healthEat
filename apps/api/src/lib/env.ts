import { z } from "zod";

// The only place the API reads process.env. Tolerant by design: a malformed or empty variable
// must never take down /api/health or the error middleware, so every field has a safe fallback and
// problems are logged once. Hard requirements (a real SESSION_SECRET in production) are asserted by
// the code that needs them (session setup), not here.
const empty = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

// Local-development placeholder for the session signing value; production refuses it (session setup).
export const LOCAL_DEV_PLACEHOLDER = "dev-only-change-me";

const EnvSchema = z.object({
  NODE_ENV: z.preprocess(empty, z.string().default("development")),
  VERCEL: z.preprocess(empty, z.string().optional()),
  VERCEL_ENV: z.preprocess(empty, z.enum(["development", "preview", "production"]).optional()),
  VERCEL_GIT_COMMIT_SHA: z.preprocess(empty, z.string().optional()),
  PORT: z.preprocess(empty, z.coerce.number().int().positive().default(4000)),
  MONGODB_URI: z.preprocess(empty, z.string().startsWith("mongodb").optional()),
  MONGODB_DB: z.preprocess(empty, z.string().optional()),
  SESSION_SECRET: z.preprocess(empty, z.string().default(LOCAL_DEV_PLACEHOLDER)),
});
export type Env = z.infer<typeof EnvSchema>;

let warned = false;

export function env(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (parsed.success) return parsed.data;
  // Drop the offending keys and parse again with defaults; warn once so the misconfiguration is visible.
  const bad = new Set(parsed.error.issues.map((i) => String(i.path[0])));
  if (!warned) {
    warned = true;
    console.error(`[api] ignoring invalid environment variable(s): ${[...bad].join(", ")}`);
  }
  const cleaned: Record<string, string | undefined> = { ...process.env };
  for (const k of bad) delete cleaned[k];
  return EnvSchema.parse(cleaned);
}

/** True when the variable is present and non-blank in the raw environment, valid or not. */
export const rawPresent = (key: string): boolean =>
  typeof process.env[key] === "string" && process.env[key]!.trim() !== "";

/**
 * Database name on the shared cluster. Development falls back to `healtheat_dev`; production never
 * falls back (a production function must not silently read and write the dev database).
 */
export function databaseName(): string | undefined {
  const e = env();
  if (e.MONGODB_DB) return e.MONGODB_DB;
  return isProduction() ? undefined : "healtheat_dev";
}

/** True on any Vercel deployment (preview, staging alias or production): all are internet-reachable. */
export const isDeployed = (): boolean => env().VERCEL === "1" || isProduction();

/** Startup assertion: every deployment must carry a real SESSION_SECRET. Fail closed. */
export function assertProductionSecrets(): void {
  if (isDeployed() && env().SESSION_SECRET === LOCAL_DEV_PLACEHOLDER) {
    throw new Error(
      "SESSION_SECRET is unset on a deployed environment; refusing to sign cookies with the development placeholder",
    );
  }
}

export const isProduction = (): boolean => {
  const e = env();
  return (
    e.VERCEL_ENV === "production" || (e.VERCEL_ENV === undefined && e.NODE_ENV === "production")
  );
};

/** Deployment environment label used by health and the web. */
export function deploymentEnv(): "local" | "development" | "preview" | "production" {
  return env().VERCEL_ENV ?? "local";
}
