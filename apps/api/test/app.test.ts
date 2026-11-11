import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { errorHandler, toHttpResponse } from "../src/middleware/error.js";
import { HealthResponse } from "@healtheat/shared";
import app from "../src/app.js";

describe("GET /api/health", () => {
  it("returns a schema-valid payload", async () => {
    const res = await request(app).get("/api/health").expect(200);
    const parsed = HealthResponse.parse(res.body);
    expect(parsed.service).toBe("healtheat-api");
    expect(parsed.env).toBe("local");
    expect(parsed.db).toBe("connected");
    expect(parsed.dbName).toBe("healtheat_test");
    expect(parsed.secrets).toBe("ok");
    expect(parsed.commit).toBe("local");
  });
});

describe("spike cookie flow", () => {
  it("login sets a signed httpOnly cookie that whoami reads back", async () => {
    const agent = request.agent(app);
    const login = await agent.post("/api/spike/login").send({ name: "hungju" }).expect(200);
    const setCookie = login.headers["set-cookie"] as unknown as string[];
    expect(setCookie.join(";")).toMatch(/he_spike=/);
    expect(setCookie.join(";")).toMatch(/HttpOnly/);
    expect(setCookie.join(";")).toMatch(/SameSite=Lax/);
    const who = await agent.get("/api/spike/whoami").expect(200);
    expect(who.body).toEqual({ name: "hungju" });
  });
  it("whoami is null without a cookie and after a tampered cookie", async () => {
    const anon = await request(app).get("/api/spike/whoami").expect(200);
    expect(anon.body).toEqual({ name: null });
    const forged = await request(app)
      .get("/api/spike/whoami")
      .set("Cookie", "he_spike=s%3Aroot.badsig")
      .expect(200);
    expect(forged.body).toEqual({ name: null });
  });
  it("slow waits the requested time (bounded)", async () => {
    const res = await request(app).get("/api/spike/slow?seconds=0.2").expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.waitedMs).toBeGreaterThanOrEqual(180);
  });
  it("unknown routes return JSON 404", async () => {
    const res = await request(app).get("/api/nope").expect(404);
    expect(res.body).toEqual({ error: "not_found" });
  });
});

describe("error middleware", () => {
  // Value: protects=a handler that fails after the response headers were sent still ends the
  //   response (the socket is closed) instead of leaving the client waiting until the platform timeout;
  //   fails_when=errorHandler returns on res.headersSent without delegating to Express (next(err)),
  //   so nothing ever ends the response; why_new=every existing error-path test fails before a byte is
  //   written, so the headersSent branch is never reached; seam=none (a route on the real spike
  //   router, the real app, the real error middleware); no_claim=does not define the status or body
  //   the client sees once the body has started streaming, only that the connection does not hang
  it("a failure after headers were sent closes the connection instead of hanging", async () => {
    // A throwaway app with the real error middleware: no shared router is mutated.
    const late = express();
    late.get("/late-failure", (_req, res) => {
      res.status(200).write("partial");
      throw new Error("failed after headers were sent");
    });
    late.use(errorHandler);
    let outcome: unknown;
    try {
      outcome = await request(late)
        .get("/late-failure")
        .timeout({ response: 3000, deadline: 4000 });
    } catch (e) {
      outcome = e;
    }
    // A hung response is the failure mode under test: superagent marks a client-side cutoff with
    // `timeout`; a closed socket (any status, or a reset) arrives long before the 3 s cutoff.
    const o = outcome as { timeout?: number; status?: number };
    expect(o.timeout, "the client timed out: the response was never ended").toBeUndefined();
    expect(o.status, "the route must have run (a 404 would mean it was never reached)").not.toBe(
      404,
    );
  });
});

describe("client errors keep their own status", () => {
  it("malformed JSON is 400 invalid_json, not a server error", async () => {
    const res = await request(app)
      .post("/api/spike/login")
      .set("content-type", "application/json")
      .send("{not json")
      .expect(400);
    expect(res.body).toEqual({ error: "invalid_json" });
  });
  it("an oversized body is 413 payload_too_large", async () => {
    const res = await request(app)
      .post("/api/spike/login")
      .set("content-type", "application/json")
      .send(JSON.stringify({ name: "x".repeat(1_100_000) }))
      .expect(413);
    expect(res.body).toEqual({ error: "payload_too_large" });
  });
});

describe("upstream errors are never relayed as the client's fault", () => {
  it("a 4xx-shaped error without expose maps to 500 internal", () => {
    const upstream = Object.assign(new Error("invalid x-api-key"), {
      status: 401,
      type: "authentication_error",
    });
    const r = toHttpResponse(upstream);
    expect(r.status).toBe(500);
    expect(r.body.error).toBe("internal");
  });
});

describe("deep health", () => {
  it("GET /api/health/db forces a live connection and names the database", async () => {
    const res = await request(app).get("/api/health/db").expect(200);
    expect(res.body).toEqual({ ok: true, db: "connected", dbName: "healtheat_test" });
  });
});
