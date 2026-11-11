import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { HttpError } from "../lib/http.js";
import { isServerSelectionError } from "../lib/db.js";
import { env } from "../lib/env.js";

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "not_found" });
};

type MongoDuplicate = { code?: number; keyValue?: Record<string, unknown> };

/** Map any thrown value to {status, body}. Exported so tests and services can reuse the mapping. */
export function toHttpResponse(err: unknown): {
  status: number;
  body: { error: string; details?: unknown };
} {
  if (err instanceof HttpError) {
    return { status: err.status, body: { error: err.code, details: err.details } };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: "validation_error",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    };
  }
  if (err instanceof Error && err.name === "ValidationError") {
    return { status: 400, body: { error: "validation_error", details: err.message } };
  }
  if (err instanceof Error && err.name === "CastError") {
    return { status: 400, body: { error: "invalid_id" } };
  }
  const dup = err as MongoDuplicate;
  if (dup && typeof dup === "object" && dup.code === 11000) {
    return {
      status: 409,
      body: { error: "conflict", details: { fields: Object.keys(dup.keyValue ?? {}) } },
    };
  }
  if (isServerSelectionError(err)) {
    return { status: 503, body: { error: "database_unavailable" } };
  }
  return {
    status: 500,
    body: {
      error: "internal",
      details:
        env().NODE_ENV === "production"
          ? undefined
          : err instanceof Error
            ? err.message
            : String(err),
    },
  };
}

// Central error middleware: always JSON, never a stack trace to the client.
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const { status, body } = toHttpResponse(err);
  if (status >= 500)
    console.error("[api]", status, err instanceof Error ? (err.stack ?? err.message) : err);
  if (res.headersSent) return;
  res.status(status).json(body);
};
