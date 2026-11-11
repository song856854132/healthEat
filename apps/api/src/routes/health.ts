import { Router } from "express";
import { HealthResponse } from "@healtheat/shared";
import pkg from "../../package.json" with { type: "json" };
import { dbState, requireDb } from "../lib/db.js";
import { databaseName, deploymentEnv, env, secretsState } from "../lib/env.js";

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  const body: HealthResponse = {
    ok: true,
    service: "healtheat-api",
    version: pkg.version,
    commit: (env().VERCEL_GIT_COMMIT_SHA ?? "local").slice(0, 12),
    env: deploymentEnv(),
    db: dbState(), // reports without forcing a connection
    dbName: databaseName() ?? null, // non-secret; lets staging prove it opened healtheat_staging
    secrets: secretsState(),
    now: new Date().toISOString(),
  };
  res.json(HealthResponse.parse(body));
});

// Deep health: forces a live connection (503 when the database is unconfigured, misconfigured or
// unreachable). The staging smoke uses it to prove the function really opened its own database.
healthRouter.get("/health/db", requireDb, (_req, res) => {
  res.json({ ok: true, db: dbState(), dbName: databaseName() ?? null });
});
