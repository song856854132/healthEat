import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { CONNECT_OPTIONS, dbState, isServerSelectionError, requireDb } from "../src/lib/db.js";
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
});

describe("error mapping", () => {
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
  it("unknown errors are 500 internal and never leak a stack", () => {
    const r = toHttpResponse(new Error("boom"));
    expect(r.status).toBe(500);
    expect(r.body.error).toBe("internal");
    expect(JSON.stringify(r.body)).not.toMatch(/at .*\.ts/);
  });
});

describe("environment tolerance (health must never depend on a valid env)", () => {
  it("treats an empty MONGODB_URI as unset and ignores an unknown NODE_ENV", async () => {
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
  it("a malformed MONGODB_URI is ignored with a warning instead of crashing", async () => {
    const saved = process.env.MONGODB_URI;
    process.env.MONGODB_URI = "postgres://nope";
    try {
      expect(dbState()).toBe("unconfigured");
    } finally {
      process.env.MONGODB_URI = saved;
    }
  });
});
