import { Router } from "express";
import { HealthResponse } from "@healtheat/shared";
import pkg from "../../package.json" with { type: "json" };
import { dbState } from "../lib/db.js";

export const healthRouter = Router();

function envName(): HealthResponse["env"] {
  const v = process.env.VERCEL_ENV;
  if (v === "production" || v === "preview" || v === "development") return v;
  return "local";
}

healthRouter.get("/health", (_req, res) => {
  const body: HealthResponse = {
    ok: true,
    service: "healtheat-api",
    version: pkg.version,
    commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? "local").slice(0, 12),
    env: envName(),
    db: dbState(), // reports without forcing a connection
    now: new Date().toISOString(),
  };
  res.json(HealthResponse.parse(body));
});
