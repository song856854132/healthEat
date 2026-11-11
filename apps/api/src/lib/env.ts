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
  MONGODB_DB: z.preprocess(empty, z.string().default("healtheat_dev")),
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
