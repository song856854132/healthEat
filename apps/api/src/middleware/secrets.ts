import type { RequestHandler } from "express";
import type { SecretsState } from "../lib/env.js";

// Fail closed without going dark: when a deployed function lacks SESSION_SECRET, every route except
// /api/health answers 503 secret_unconfigured, and health reports `secrets: "missing"` so the
// staging smoke and an operator can read the cause instead of an opaque platform error.
export function secretsGuard(state: () => SecretsState): RequestHandler {
  return (req, res, next) => {
    if (state() === "ok" || req.path.startsWith("/api/health")) return next();
    res.status(503).json({ error: "secret_unconfigured" });
  };
}
