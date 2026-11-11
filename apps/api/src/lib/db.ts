import mongoose from "mongoose";
import type { DbState } from "@healtheat/shared";
import { databaseName, env, rawPresent } from "./env.js";
import { HttpError, asyncHandler } from "./http.js";

// Plan decisions (design doc, Reliability A4/A5/P2): one Mongoose connection cached on globalThis so
// warm Vercel invocations reuse it; maxPoolSize 5 (Atlas M0 allows 500 connections, many functions
// may be warm); serverSelectionTimeoutMS 5000 so an unreachable or throttled Atlas returns 503 in
// five seconds instead of hanging until the function limit.
//
// bufferCommands: false so a model call on a dropped connection fails fast (and maps to 503) instead
// of buffering for 10 s and surfacing as a 500. autoIndex stays on: createIndex is idempotent and the
// four phase-0 collections cost four no-op round-trips per cold start; revisit when T3/T6 add
// collections (then: autoIndex off in production, syncIndexes in a deploy step).
export const CONNECT_OPTIONS = {
  maxPoolSize: 5,
  serverSelectionTimeoutMS: 5000,
  bufferCommands: false,
  autoIndex: true,
} as const;

type G = typeof globalThis & { __healtheatDb?: Promise<typeof mongoose> };
const g = globalThis as G;

export function dbState(): DbState {
  if (!env().MONGODB_URI) return rawPresent("MONGODB_URI") ? "misconfigured" : "unconfigured";
  if (!databaseName()) return "misconfigured";
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
  const { MONGODB_URI } = env();
  if (!MONGODB_URI) {
    return rawPresent("MONGODB_URI")
      ? Promise.reject(
          new HttpError(
            503,
            "database_misconfigured",
            "MONGODB_URI is present but not a mongodb:// or mongodb+srv:// URI",
          ),
        )
      : Promise.reject(new HttpError(503, "database_unconfigured", "MONGODB_URI is not set"));
  }
  const dbName = databaseName();
  if (!dbName) {
    return Promise.reject(
      new HttpError(503, "database_misconfigured", "MONGODB_DB must be set in production"),
    );
  }
  if (!g.__healtheatDb) {
    g.__healtheatDb = mongoose
      .connect(MONGODB_URI, { ...CONNECT_OPTIONS, dbName })
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
