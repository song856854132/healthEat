import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CONNECT_OPTIONS,
  connectDb,
  dbState,
  disconnectDb,
  isServerSelectionError,
  requireDb,
} from "../src/lib/db.js";
import { errorHandler } from "../src/middleware/error.js";
import { HttpError } from "../src/lib/http.js";
import { toHttpResponse } from "../src/middleware/error.js";

function probeApp() {
  const app = express();
  app.get("/probe", requireDb, (_req, res) => res.json({ ok: true, db: dbState() }));
  app.use(errorHandler);
  return app;
}

describe("database connection (T9 reliability baseline)", () => {
  it("is connected under the test harness and requireDb lets requests through", async () => {
    const res = await request(probeApp()).get("/probe").expect(200);
    expect(res.body).toEqual({ ok: true, db: "connected" });
  });

  it("answers 503 database_unconfigured when MONGODB_URI is absent", async () => {
    const saved = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;
    try {
      expect(dbState()).toBe("unconfigured");
      const res = await request(probeApp()).get("/probe").expect(503);
      expect(res.body.error).toBe("database_unconfigured");
    } finally {
      process.env.MONGODB_URI = saved;
    }
  });

  it("an unreachable server fails within the 5 s selection timeout and maps to 503", async () => {
    const started = Date.now();
    const conn = mongoose.createConnection("mongodb://127.0.0.1:1/unreachable", {
      ...CONNECT_OPTIONS,
      serverSelectionTimeoutMS: 1500, // same code path as the 5 s production value, shorter for the test
    });
    let caught: unknown;
    try {
      await conn.asPromise();
    } catch (err) {
      caught = err;
    } finally {
      await conn.close().catch(() => undefined);
    }
    expect(caught, "connection must fail").toBeTruthy();
    expect(isServerSelectionError(caught)).toBe(true);
    // gstack-timing-ok: the 5 s selection timeout is the contract under test (design doc, Reliability A4)
    expect(Date.now() - started).toBeLessThan(5000);
    expect(toHttpResponse(caught)).toEqual({
      status: 503,
      body: { error: "database_unavailable" },
    });
  });

  // Value: protects=while the database is unreachable a client of a database route gets
  //   503 database_unavailable within the 5 s selection timeout, health reports "connecting" meanwhile,
  //   and once the database is reachable again the very next request succeeds; fails_when=requireDb
  //   stops mapping the driver's selection error to 503, the selection timeout grows past 5 s, or
  //   connectDb keeps the failed promise cached so every later request fails too; why_new=the test
  //   above uses a side connection and the pure mapper, never requireDb or the shared cached
  //   connection; seam=none (MONGODB_URI and the real connect path); no_claim=does not cover a
  //   connection that drops after it was established (needs a stoppable server: e2e)
  it("an unreachable database answers 503 database_unavailable and recovers on the next request", async () => {
    const good = process.env.MONGODB_URI;
    await disconnectDb();
    process.env.MONGODB_URI = "mongodb://127.0.0.1:1/unreachable";
    try {
      const started = Date.now();
      const pending = request(probeApp())
        .get("/probe")
        .then((r) => r); // superagent sends on .then
      await vi.waitFor(() => expect(dbState()).toBe("connecting"));
      const res = await pending;
      // gstack-timing-ok: the 5 s selection timeout is the contract under test (design doc, Reliability A4)
      expect(Date.now() - started).toBeLessThan(CONNECT_OPTIONS.serverSelectionTimeoutMS + 3000);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        error: "database_unavailable",
        details: "the database did not answer within 5 seconds",
      });
      expect(dbState()).toBe("disconnected");

      process.env.MONGODB_URI = good;
      const recovered = await request(probeApp()).get("/probe").expect(200);
      expect(recovered.body).toEqual({ ok: true, db: "connected" });
    } finally {
      process.env.MONGODB_URI = good;
      await connectDb();
    }
  });
});

describe("error mapping", () => {
  it("driver network and topology errors map to 503 regardless of subclass name", () => {
    const { MongoNetworkTimeoutError, MongoTopologyClosedError } = mongoose.mongo;
    expect(isServerSelectionError(new MongoNetworkTimeoutError("socket timed out"))).toBe(true);
    expect(isServerSelectionError(new MongoTopologyClosedError())).toBe(true);
    expect(isServerSelectionError(new Error("MongoNetworkTimeoutError"))).toBe(false);
    expect(toHttpResponse(new MongoNetworkTimeoutError("x")).status).toBe(503);
  });
  it("HttpError keeps its status and code", () => {
    expect(toHttpResponse(new HttpError(418, "teapot", "short and stout"))).toEqual({
      status: 418,
      body: { error: "teapot", details: "short and stout" },
    });
  });
  it("duplicate key becomes 409 conflict with the field names", () => {
    const dup = Object.assign(new Error("E11000"), { code: 11000, keyValue: { username: "x" } });
    expect(toHttpResponse(dup)).toEqual({
      status: 409,
      body: { error: "conflict", details: { fields: ["username"] } },
    });
  });
  // Value: protects=a request body that fails zod validation answers 400 validation_error listing
  //   every offending field path with a message, never a 500; fails_when=toHttpResponse stops
  //   recognising ZodError (dropped branch, or a zod major that changes the class) or the details
  //   shape changes; why_new=no test threw a ZodError through the middleware; seam=none (probe route,
  //   real error middleware); no_claim=does not cover zod errors raised outside a request
  it("a zod validation failure in a handler answers 400 with field paths", async () => {
    const Body = z.object({
      name: z.string().min(1),
      profile: z.object({ age: z.number().int() }),
    });
    const app = express();
    app.use(express.json());
    app.post("/validate", (req, res) => {
      Body.parse(req.body);
      res.json({ ok: true });
    });
    app.use(errorHandler);
    const res = await request(app)
      .post("/validate")
      .send({ name: "", profile: { age: "x" } })
      .expect(400);
    expect(res.body.error).toBe("validation_error");
    const details = res.body.details as { path: string; message: string }[];
    expect(details.map((d) => d.path).sort()).toEqual(["name", "profile.age"]);
    for (const d of details) expect(d.message.length).toBeGreaterThan(0);
  });
  // Value: protects=an unexpected error answers 500 internal; outside production the message is
  //   included for debugging, in production the body carries no detail at all and never a stack;
  //   fails_when=the production check is inverted or dropped (internals leak to clients) or the
  //   message disappears from development responses; why_new=the original assertion only looked for a
  //   stack frame and never exercised NODE_ENV=production; seam=none (NODE_ENV is the real switch);
  //   no_claim=does not cover the server-side log line
  it("unknown errors are 500 internal; details only outside production, never a stack", () => {
    const r = toHttpResponse(new Error("boom"));
    expect(r.status).toBe(500);
    expect(r.body.error).toBe("internal");
    expect(r.body.details).toBe("boom");
    expect(JSON.stringify(r.body)).not.toMatch(/at .*\.ts/);
    expect(toHttpResponse("thrown string").body.details).toBe("thrown string");
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const prod = toHttpResponse(new Error("boom"));
      expect(prod.status).toBe(500);
      expect(prod.body).toEqual({ error: "internal" });
      expect("details" in prod.body && prod.body.details !== undefined).toBe(false);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});

describe("environment tolerance (health must never depend on a valid env)", () => {
  it("treats an empty MONGODB_URI as unset while health keeps answering", async () => {
    const saved = { uri: process.env.MONGODB_URI, node: process.env.NODE_ENV };
    process.env.MONGODB_URI = "";
    process.env.NODE_ENV = "staging";
    try {
      expect(dbState()).toBe("unconfigured");
      const { default: app } = await import("../src/app.js");
      const res = await request(app).get("/api/health").expect(200);
      expect(res.body.db).toBe("unconfigured");
    } finally {
      process.env.MONGODB_URI = saved.uri;
      process.env.NODE_ENV = saved.node;
    }
  });
  it("a malformed MONGODB_URI reports misconfigured (not unconfigured) and does not crash", async () => {
    const saved = process.env.MONGODB_URI;
    process.env.MONGODB_URI = "postgres://nope";
    try {
      expect(dbState()).toBe("misconfigured");
      const res = await request(probeApp()).get("/probe").expect(503);
      expect(res.body.error).toBe("database_misconfigured");
    } finally {
      process.env.MONGODB_URI = saved;
    }
  });
});

describe("production fail-closed rules", () => {
  it("reports the development SESSION_SECRET placeholder as missing in production", async () => {
    const saved = { v: process.env.VERCEL_ENV, s: process.env.SESSION_SECRET };
    process.env.VERCEL_ENV = "production";
    delete process.env.SESSION_SECRET;
    try {
      const { secretsState } = await import("../src/lib/env.js");
      expect(secretsState()).toBe("missing");
    } finally {
      process.env.VERCEL_ENV = saved.v;
      process.env.SESSION_SECRET = saved.s;
    }
  });
  it("never falls back to the dev database name in production", async () => {
    const saved = { v: process.env.VERCEL_ENV, d: process.env.MONGODB_DB };
    process.env.VERCEL_ENV = "production";
    delete process.env.MONGODB_DB;
    try {
      expect(dbState()).toBe("misconfigured");
      const res = await request(probeApp()).get("/probe").expect(503);
      expect(res.body.error).toBe("database_misconfigured");
      expect(res.body.details, "5xx details are redacted in production").toBeUndefined();
    } finally {
      process.env.VERCEL_ENV = saved.v;
      process.env.MONGODB_DB = saved.d;
    }
  });
});

describe("deployed environments refuse the placeholder secret", () => {
  it("a Vercel preview without SESSION_SECRET reports missing too", async () => {
    const saved = {
      v: process.env.VERCEL,
      e: process.env.VERCEL_ENV,
      s: process.env.SESSION_SECRET,
    };
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "preview";
    delete process.env.SESSION_SECRET;
    try {
      const { secretsState } = await import("../src/lib/env.js");
      expect(secretsState()).toBe("missing");
    } finally {
      process.env.VERCEL = saved.v;
      process.env.VERCEL_ENV = saved.e;
      process.env.SESSION_SECRET = saved.s;
    }
  });
});

describe("deployment rules: happy paths and the local fallback", () => {
  it("a deployment with a real SESSION_SECRET is ok and the guard lets requests through", async () => {
    const saved = {
      v: process.env.VERCEL,
      e: process.env.VERCEL_ENV,
      s: process.env.SESSION_SECRET,
    };
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "preview";
    process.env.SESSION_SECRET = "a-real-secret-value";
    try {
      const { secretsState } = await import("../src/lib/env.js");
      expect(secretsState()).toBe("ok");
    } finally {
      process.env.VERCEL = saved.v;
      process.env.VERCEL_ENV = saved.e;
      process.env.SESSION_SECRET = saved.s;
    }
  });
  it("local runs may use the placeholder, and fall back to healtheat_dev", async () => {
    const saved = {
      v: process.env.VERCEL,
      e: process.env.VERCEL_ENV,
      s: process.env.SESSION_SECRET,
      d: process.env.MONGODB_DB,
      n: process.env.NODE_ENV,
    };
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.SESSION_SECRET;
    delete process.env.MONGODB_DB;
    process.env.NODE_ENV = "development";
    try {
      const { databaseName, secretsState } = await import("../src/lib/env.js");
      expect(secretsState()).toBe("ok");
      expect(databaseName()).toBe("healtheat_dev");
    } finally {
      process.env.VERCEL = saved.v;
      process.env.VERCEL_ENV = saved.e;
      process.env.SESSION_SECRET = saved.s;
      process.env.MONGODB_DB = saved.d;
      process.env.NODE_ENV = saved.n;
    }
  });
  it("production uses MONGODB_DB when set, and a preview without it is misconfigured", async () => {
    const saved = { v: process.env.VERCEL, e: process.env.VERCEL_ENV, d: process.env.MONGODB_DB };
    const { databaseName, isProduction } = await import("../src/lib/env.js");
    process.env.VERCEL_ENV = "production";
    process.env.MONGODB_DB = "healtheat_prod";
    try {
      expect(databaseName()).toBe("healtheat_prod");
      expect(dbState()).not.toBe("misconfigured");
      process.env.VERCEL = "1";
      process.env.VERCEL_ENV = "preview";
      delete process.env.MONGODB_DB;
      expect(databaseName()).toBeUndefined();
      expect(dbState()).toBe("misconfigured");
      // VERCEL_ENV decides production, not NODE_ENV: a preview build runs with NODE_ENV=production.
      process.env.NODE_ENV = "production";
      expect(isProduction()).toBe(false);
    } finally {
      process.env.VERCEL = saved.v;
      process.env.VERCEL_ENV = saved.e;
      process.env.MONGODB_DB = saved.d;
      process.env.NODE_ENV = "test";
    }
  });
  it("PORT falls back to 4000 when unset or not a number", async () => {
    const saved = process.env.PORT;
    const { env } = await import("../src/lib/env.js");
    delete process.env.PORT;
    expect(env().PORT).toBe(4000);
    process.env.PORT = "not-a-port";
    try {
      expect(env().PORT).toBe(4000);
    } finally {
      if (saved === undefined) delete process.env.PORT;
      else process.env.PORT = saved;
    }
  });
  it("the secrets guard answers 503 everywhere except health while the secret is missing", async () => {
    const { secretsGuard } = await import("../src/middleware/secrets.js");
    const guarded = express();
    guarded.use(secretsGuard(() => "missing"));
    guarded.get("/api/health", (_req, res) => res.json({ ok: true }));
    guarded.get("/api/other", (_req, res) => res.json({ ok: true }));
    await request(guarded).get("/api/health").expect(200);
    const res = await request(guarded).get("/api/other").expect(503);
    expect(res.body).toEqual({ error: "secret_unconfigured" });
  });
});

describe("Mongoose bufferCommands=false guard", () => {
  it("the real 'before initial connection is complete' error maps to 503", () => {
    const err = new mongoose.Error(
      "Cannot call `users.findOne()` before initial connection is complete if `bufferCommands = false`. Make sure you `await mongoose.connect()` if you have `bufferCommands = false`.",
    );
    expect(isServerSelectionError(err)).toBe(true);
    expect(toHttpResponse(err).status).toBe(503);
    expect(isServerSelectionError(new mongoose.Error("some other mongoose error"))).toBe(false);
  });
});
