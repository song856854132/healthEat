import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Error with an HTTP status and a stable machine-readable code; the error middleware renders it. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  /** Extra response headers the error middleware sets, e.g. `Retry-After` on a 429. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * True when `details` is a message written for users (for example "USDA is unavailable right now"):
   * the error middleware then shows it even on a 5xx from a deployment, where details are otherwise
   * withheld because they describe our configuration.
   */
  readonly expose: boolean;
  constructor(
    status: number,
    code: string,
    details?: unknown,
    options: { headers?: Readonly<Record<string, string>>; expose?: boolean } = {},
  ) {
    super(typeof details === "string" ? details : code);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = options.headers;
    this.expose = options.expose ?? false;
  }
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown;

/** Wrap an async route so a rejected promise reaches the error middleware instead of hanging. */
export function asyncHandler(fn: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
