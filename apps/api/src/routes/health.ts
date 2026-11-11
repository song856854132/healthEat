import { Router } from "express";
import { HealthResponse } from "@healtheat/shared";
import pkg from "../../package.json" with { type: "json" };
import { dbState } from "../lib/db.js";
import { deploymentEnv, env } from "../lib/env.js";

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  const body: HealthResponse = {
    ok: true,
    service: "healtheat-api",
    version: pkg.version,
    commit: (env().VERCEL_GIT_COMMIT_SHA ?? "local").slice(0, 12),
    env: deploymentEnv(),
    db: dbState(), // reports without forcing a connection
    now: new Date().toISOString(),
  };
  res.json(HealthResponse.parse(body));
});
