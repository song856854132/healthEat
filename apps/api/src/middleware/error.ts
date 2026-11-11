import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { HttpError } from "../lib/http.js";
import { isServerSelectionError } from "../lib/db.js";
import { env, isProduction } from "../lib/env.js";

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "not_found" });
};

type MongoDuplicate = { code?: number; keyValue?: Record<string, unknown> };
type ClientError = { status?: number; statusCode?: number; expose?: boolean; type?: string };

const CLIENT_ERROR_CODES: Record<string, string> = {
  "entity.parse.failed": "invalid_json",
  "entity.too.large": "payload_too_large",
  "encoding.unsupported": "unsupported_encoding",
  "charset.unsupported": "unsupported_charset",
  "entity.verify.failed": "invalid_body",
  "request.aborted": "request_aborted",
  "stream.encoding.set": "invalid_body",
};

/** Map any thrown value to {status, body}. Exported so tests and services can reuse the mapping. */
export function toHttpResponse(err: unknown): {
  status: number;
  body: { error: string; details?: unknown };
} {
  if (err instanceof HttpError) {
    // 5xx details describe our own configuration or infrastructure; never ship them to production clients.
    const details = err.status >= 500 && isProduction() ? undefined : err.details;
    return { status: err.status, body: { error: err.code, details } };
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
  // Errors raised by body-parser and other http-errors carry their own 4xx status (`expose: true`):
  // a malformed JSON body is the client's mistake, not a server fault, and must not log as 5xx.
  const client = err as ClientError;
  const clientStatus =
    client && typeof client === "object" ? (client.status ?? client.statusCode) : undefined;
  if (typeof clientStatus === "number" && clientStatus >= 400 && clientStatus < 500) {
    const code =
      (client.type && CLIENT_ERROR_CODES[client.type]) ??
      (clientStatus === 413 ? "payload_too_large" : "bad_request");
    return { status: clientStatus, body: { error: code } };
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
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  const { status, body } = toHttpResponse(err);
  if (status >= 500)
    console.error("[api]", status, err instanceof Error ? (err.stack ?? err.message) : err);
  // Headers already on the wire: only Express's default handler closes the connection, and only
  // when delegated to; returning here would leave the client hanging until the function limit.
  if (res.headersSent) return next(err);
  res.status(status).json(body);
};
