import { z } from "zod";

// The only place the API reads process.env. Tolerant by design: a malformed or empty variable
// must never take down /api/health or the error middleware, so every field has a safe fallback and
// problems are logged once. Deployment hard rules live below as explicit checks (secretsState,
// databaseName) that the app consults at startup and per request; they fail closed with a readable
// 503 rather than crashing the function, so /api/health can still say what is wrong.
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
  // Comma-separated usernames that hold `admin` (design doc D10): the bootstrap for the first Admin.
  ADMIN_USERNAMES: z.preprocess(empty, z.string().optional()),
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
 * Database name on the shared cluster. Local runs fall back to `healtheat_dev`; a deployed function
 * (preview, staging alias or production) never falls back: all of them are internet-reachable and
 * must not silently read and write the dev database.
 */
export function databaseName(): string | undefined {
  const e = env();
  if (e.MONGODB_DB) return e.MONGODB_DB;
  return isDeployed() ? undefined : "healtheat_dev";
}

/** True on any Vercel deployment (preview, staging alias or production): all are internet-reachable. */
export const isDeployed = (): boolean => env().VERCEL === "1" || isProduction();

export type SecretsState = "ok" | "missing";

/**
 * Deployment rule: every deployed function must carry a real SESSION_SECRET. Reported, not thrown,
 * so /api/health can name the problem; app.ts refuses every other route with 503 while "missing".
 */
export function secretsState(): SecretsState {
  return isDeployed() && env().SESSION_SECRET === LOCAL_DEV_PLACEHOLDER ? "missing" : "ok";
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

/**
 * Usernames that get the admin role at login (D10); registering one is refused (409 username_reserved). Set per Vercel environment; the list
 * is authoritative, so revoking `admin` from a listed username is undone at its next login.
 */
export function adminUsernames(): Set<string> {
  const raw = env().ADMIN_USERNAMES ?? "";
  return new Set(
    raw
      .split(",")
      .map((u) => u.trim().toLowerCase())
      .filter(Boolean),
  );
}
