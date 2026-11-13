import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Error with an HTTP status and a stable machine-readable code; the error middleware renders it. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  /** Extra response headers the error middleware sets, e.g. `Retry-After` on a 429. */
  readonly headers?: Readonly<Record<string, string>>;
  constructor(
    status: number,
    code: string,
    details?: unknown,
    headers?: Readonly<Record<string, string>>,
  ) {
    super(typeof details === "string" ? details : code);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown;

/** Wrap an async route so a rejected promise reaches the error middleware instead of hanging. */
export function asyncHandler(fn: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
