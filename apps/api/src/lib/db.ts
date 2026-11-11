import mongoose from "mongoose";
import { env } from "./env.js";
import { HttpError, asyncHandler } from "./http.js";

// Plan decisions (design doc, Reliability A4/A5/P2): one Mongoose connection cached on globalThis so
// warm Vercel invocations reuse it; maxPoolSize 5 (Atlas M0 allows 500 connections, many functions
// may be warm); serverSelectionTimeoutMS 5000 so an unreachable or throttled Atlas returns 503 in
// five seconds instead of hanging until the function limit.
export const CONNECT_OPTIONS = {
  maxPoolSize: 5,
  serverSelectionTimeoutMS: 5000,
  autoIndex: true,
} as const;

type G = typeof globalThis & { __healtheatDb?: Promise<typeof mongoose> };
const g = globalThis as G;

export type DbState = "connected" | "connecting" | "disconnected" | "unconfigured";

export function dbState(): DbState {
  if (!env().MONGODB_URI) return "unconfigured";
  switch (mongoose.connection.readyState) {
    case 1:
      return "connected";
    case 2:
      return "connecting";
    default:
      return "disconnected";
  }
}

/** Connect (once) to the configured database. Rejects with HttpError 503 when unconfigured. */
export function connectDb(): Promise<typeof mongoose> {
  const { MONGODB_URI, MONGODB_DB } = env();
  if (!MONGODB_URI) {
    return Promise.reject(new HttpError(503, "database_unconfigured", "MONGODB_URI is not set"));
  }
  if (!g.__healtheatDb) {
    g.__healtheatDb = mongoose
      .connect(MONGODB_URI, { ...CONNECT_OPTIONS, dbName: MONGODB_DB })
      .catch((err: unknown) => {
        g.__healtheatDb = undefined; // let the next request retry instead of caching the failure
        throw err;
      });
  }
  return g.__healtheatDb;
}

export async function disconnectDb(): Promise<void> {
  g.__healtheatDb = undefined;
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}

/** True for the driver's "could not reach a server" family of errors. */
export function isServerSelectionError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  return (
    name === "MongooseServerSelectionError" ||
    name === "MongoServerSelectionError" ||
    name === "MongoNetworkError"
  );
}

/** Route-level guard: ensures a live connection or answers 503 (unconfigured or unavailable). */
export const requireDb = asyncHandler(async (_req, _res, next) => {
  try {
    await connectDb();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (isServerSelectionError(err)) {
      throw new HttpError(
        503,
        "database_unavailable",
        "the database did not answer within 5 seconds",
      );
    }
    throw err;
  }
  next();
});
