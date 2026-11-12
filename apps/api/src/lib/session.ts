import type { RequestHandler } from "express";
import session from "express-session";
// Named import: Vercel's Express builder resolves connect-mongo's default export through the CJS typings
// (dist/index.d.cts) and rejects `MongoStore.create`; `MongoStore` is a named export in both builds.
import { MongoStore } from "connect-mongo";
import type { Role } from "@healtheat/shared";
import { SESSION_COOKIE } from "@healtheat/shared";
import { connectDb } from "./db.js";
import { databaseName, env, isDeployed } from "./env.js";

// Design doc, Auth and sessions: express-session with a connect-mongo store so sessions survive
// serverless cold starts (rubric: "maintain session"). Cookie httpOnly, secure on every deployment
// (all are https behind the Next.js rewrite; `trust proxy 1` in app.ts makes req.secure true there),
// sameSite lax, no domain (same-origin through the proxy). Fourteen days, rolling.
export const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;

declare module "express-session" {
  interface SessionData {
    userId: string;
    activeRole: Role;
  }
}

let middleware: RequestHandler | undefined;

/**
 * The session middleware, built on first use. It must run behind `requireDb`: the store takes the
 * driver client from the live Mongoose connection, so an unreachable database answers 503 before
 * express-session ever asks the store (otherwise the store's error would surface as a 500).
 */
export function sessionMiddleware(): RequestHandler {
  return (req, res, next) => {
    middleware ??= buildSession();
    middleware(req, res, next);
  };
}

function buildSession(): RequestHandler {
  const store = MongoStore.create({
    clientPromise: connectDb().then((m) => m.connection.getClient()),
    dbName: databaseName(),
    collectionName: "sessions",
    ttl: SESSION_TTL_SECONDS,
    // Rolling cookies would otherwise write the session on every request; once a day is enough and
    // keeps the M0 cluster's 100 ops/s budget for real work.
    touchAfter: 24 * 60 * 60,
    // Native documents, not JSON strings: the T5 deletion cascade removes a user's sessions with
    // `sessions.deleteMany({ "session.userId": id })`, which needs a queryable field.
    stringify: false,
  });
  // connect-mongo caches its collection promise (TTL-index creation included); a rejection there would
  // make every later request on this warm instance a 500. Forget the middleware instead, so the next
  // request rebuilds the store; the Mongoose connection itself is owned by db.ts and survives.
  void store.collectionP.catch(() => {
    middleware = undefined;
  });
  return session({
    name: SESSION_COOKIE,
    secret: env().SESSION_SECRET,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: isDeployed(),
      sameSite: "lax",
      maxAge: SESSION_TTL_SECONDS * 1000,
      path: "/",
    },
  });
}
