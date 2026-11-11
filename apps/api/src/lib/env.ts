import { z } from "zod";

// The only place the API reads process.env. Parsed on every call so tests can change values;
// the cost is negligible and it keeps routers free of environment access.
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  VERCEL: z.string().optional(),
  VERCEL_ENV: z.enum(["development", "preview", "production"]).optional(),
  VERCEL_GIT_COMMIT_SHA: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z.string().url().or(z.string().startsWith("mongodb")).optional(),
  MONGODB_DB: z.string().min(1).default("healtheat_dev"),
  SESSION_SECRET: z.string().min(1).default("dev-only-change-me"),
});
export type Env = z.infer<typeof EnvSchema>;

export function env(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const e = parsed.data;
  if (e.NODE_ENV === "production" && e.SESSION_SECRET === "dev-only-change-me") {
    throw new Error("SESSION_SECRET must be set in production");
  }
  return e;
}

export const isProduction = (): boolean =>
  env().NODE_ENV === "production" || env().VERCEL_ENV === "production";
