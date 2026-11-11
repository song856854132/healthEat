import { describe, expect, it } from "vitest";
import request from "supertest";
import { HealthResponse } from "@healtheat/shared";
import app from "../src/app.js";
import { spikeRouter } from "../src/routes/spike.js";

describe("GET /api/health", () => {
  it("returns a schema-valid payload", async () => {
    const res = await request(app).get("/api/health").expect(200);
    const parsed = HealthResponse.parse(res.body);
    expect(parsed.service).toBe("healtheat-api");
    expect(parsed.env).toBe("local");
    expect(parsed.db).toBe("connected");
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
    spikeRouter.get("/late-failure", (_req, res) => {
      res.status(200).write("partial");
      throw new Error("failed after headers were sent");
    });
    let outcome: unknown;
    try {
      outcome = await request(app)
        .get("/api/spike/late-failure")
        .timeout({ response: 3000, deadline: 4000 });
    } catch (e) {
      outcome = e;
    }
    // A hung response is the failure mode under test: superagent marks a client-side cutoff with
    // `timeout`; a closed socket (any status, or a reset) arrives long before the 3 s cutoff.
    expect(
      (outcome as { timeout?: number }).timeout,
      "the client timed out: the response was never ended",
    ).toBeUndefined();
  });
});
