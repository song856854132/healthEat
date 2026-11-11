import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MeResponse, PRIVACY_ACK_COOKIE, SESSION_COOKIE } from "@healtheat/shared";
import app from "../src/app.js";
import { User } from "../src/models/index.js";
import { requireAuth, requireRole } from "../src/middleware/auth.js";
import { requireDb } from "../src/lib/db.js";
import { sessionMiddleware } from "../src/lib/session.js";
import { errorHandler } from "../src/middleware/error.js";
import { authRouter } from "../src/routes/auth.js";
import { MemberProfile } from "../src/models/index.js";

const valid = {
  username: "hungju",
  email: "hungju@example.com",
  password: "correct horse battery",
  timezone: "Asia/Taipei",
};

const cookieHeader = (res: request.Response): string =>
  ((res.headers["set-cookie"] as unknown as string[] | undefined) ?? []).join("; ");

async function registered(overrides: Partial<typeof valid> = {}) {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/register")
    .send({ ...valid, ...overrides })
    .expect(201);
  return { agent, res };
}

describe("POST /api/auth/register", () => {
  it("creates the account and member profile, starts a session and returns /me", async () => {
    const { agent, res } = await registered({ username: " Hung_Ju ", email: "Hung@Example.com" });
    const body = MeResponse.parse(res.body);
    expect(body.user).toMatchObject({
      username: "hung_ju",
      email: "hung@example.com",
      roles: ["member"],
      status: "active",
      activeRole: "member",
      privacyAckAt: null,
    });
    expect(body.profiles).toEqual({ member: true, curator: false, admin: false });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
    const set = cookieHeader(res);
    expect(set).toMatch(new RegExp(`${SESSION_COOKIE}=`));
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Lax/);
    expect(set, "local run: no Secure flag").not.toMatch(/Secure/);
    const me = await agent.get("/api/auth/me").expect(200);
    expect(me.body.user.username).toBe("hung_ju");
    const stored = await User.findOne({ username: "hung_ju" }).select("+passwordHash");
    expect(stored?.passwordHash).toMatch(/^\$2[aby]\$12\$/);
  });

  it("stores the session in the sessions collection as a document with the user id", async () => {
    const { res } = await registered();
    const sessions = await mongoose.connection.db!.collection("sessions").find({}).toArray();
    expect(sessions).toHaveLength(1);
    const user = await User.findOne({ username: valid.username });
    expect(sessions[0].session.userId).toBe(user!.id);
    expect(sessions[0].session.activeRole).toBe("member");
    expect(sessions[0].expires).toBeInstanceOf(Date);
    expect(cookieHeader(res)).toContain(encodeURIComponent(String(sessions[0]._id)).slice(0, 8));
  });

  it("rejects a taken username or email with 409 conflict naming the field", async () => {
    await registered();
    const dupName = await request(app)
      .post("/api/auth/register")
      .send({ ...valid, email: "other@example.com" })
      .expect(409);
    expect(dupName.body).toEqual({ error: "conflict", details: { fields: ["username"] } });
    const dupMail = await request(app)
      .post("/api/auth/register")
      .send({ ...valid, username: "another" })
      .expect(409);
    expect(dupMail.body.details.fields).toEqual(["email"]);
    expect(await User.countDocuments()).toBe(1);
  });

  it("rejects an unknown time zone, a short password and a bad username as 400 validation_error", async () => {
    const tz = await request(app)
      .post("/api/auth/register")
      .send({ ...valid, timezone: "Mars/Olympus" })
      .expect(400);
    expect(tz.body.error).toBe("validation_error");
    expect(tz.body.details).toEqual([{ path: "timezone", message: "unknown IANA time zone" }]);
    const pw = await request(app)
      .post("/api/auth/register")
      .send({ ...valid, password: "short" })
      .expect(400);
    expect(pw.body.details[0].path).toBe("password");
    const name = await request(app)
      .post("/api/auth/register")
      .send({ ...valid, username: "Has Space!" })
      .expect(400);
    expect(name.body.details[0].path).toBe("username");
    expect(await User.countDocuments()).toBe(0);
  });

  it("accepts UTC and legacy zone spellings and stores the canonical name on the profile", async () => {
    await registered({ timezone: "utc" });
    const user = await User.findOne({ username: valid.username });
    const profile = await MemberProfile.findOne({ userId: user!._id });
    expect(profile?.timezone).toBe("UTC");
  });
});

describe("POST /api/auth/login", () => {
  it("logs in with the right password and regenerates the session id", async () => {
    const { res: reg } = await registered();
    const first = cookieHeader(reg).match(/he_sid=([^;]+)/)![1];
    const agent = request.agent(app);
    const res = await agent
      .post("/api/auth/login")
      .send({ username: "HUNGJU", password: valid.password })
      .expect(200);
    expect(MeResponse.parse(res.body).user.username).toBe("hungju");
    const second = cookieHeader(res).match(/he_sid=([^;]+)/)![1];
    expect(second).not.toBe(first);
    await agent.get("/api/auth/me").expect(200);
  });

  it("answers the same 401 body for an unknown user and a wrong password", async () => {
    await registered();
    const unknown = await request(app)
      .post("/api/auth/login")
      .send({ username: "nobody", password: valid.password })
      .expect(401);
    const wrong = await request(app)
      .post("/api/auth/login")
      .send({ username: valid.username, password: "wrong password here" })
      .expect(401);
    expect(unknown.body).toEqual({ error: "invalid_credentials" });
    expect(wrong.body).toEqual(unknown.body);
    expect(cookieHeader(unknown)).toBe("");
    expect(cookieHeader(wrong)).toBe("");
  });

  it("refuses a suspended account with 403 only after the password matched", async () => {
    await registered();
    await User.updateOne({ username: valid.username }, { status: "suspended" });
    const wrong = await request(app)
      .post("/api/auth/login")
      .send({ username: valid.username, password: "wrong password here" })
      .expect(401);
    expect(wrong.body.error).toBe("invalid_credentials");
    const right = await request(app)
      .post("/api/auth/login")
      .send({ username: valid.username, password: valid.password })
      .expect(403);
    expect(right.body).toEqual({ error: "account_suspended" });
    expect(cookieHeader(right)).toBe("");
  });

  it("refuses an account pending deletion with 403 account_deletion_pending", async () => {
    await registered();
    await User.updateOne({ username: valid.username }, { deletionPending: true });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: valid.username, password: valid.password })
      .expect(403);
    expect(res.body).toEqual({ error: "account_deletion_pending" });
  });
});

describe("GET /api/auth/me and POST /api/auth/logout", () => {
  it("is 401 unauthenticated without a session and after logout, which clears the cookie", async () => {
    const anon = await request(app).get("/api/auth/me").expect(401);
    expect(anon.body).toEqual({ error: "unauthenticated" });
    const { agent } = await registered();
    const out = await agent.post("/api/auth/logout").expect(200);
    expect(cookieHeader(out)).toMatch(new RegExp(`${SESSION_COOKIE}=;`));
    await agent.get("/api/auth/me").expect(401);
    expect(await mongoose.connection.db!.collection("sessions").countDocuments()).toBe(0);
    await request(app).post("/api/auth/logout").expect(200);
  });

  it("ignores a forged or stale session cookie", async () => {
    await request(app)
      .get("/api/auth/me")
      .set("Cookie", `${SESSION_COOKIE}=s%3Aforged.sig`)
      .expect(401);
  });

  it("ends an existing session when the account is suspended afterwards", async () => {
    const { agent } = await registered();
    await User.updateOne({ username: valid.username }, { status: "suspended" });
    const res = await agent.get("/api/auth/me").expect(403);
    expect(res.body).toEqual({ error: "account_suspended" });
    expect(await mongoose.connection.db!.collection("sessions").countDocuments()).toBe(0);
    await User.updateOne({ username: valid.username }, { status: "active" });
    await agent.get("/api/auth/me").expect(401);
  });
});

describe("privacy acknowledgment mirror", () => {
  it("cookie at register -> privacyAckAt on the account", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .set("Cookie", `${PRIVACY_ACK_COOKIE}=1`)
      .send(valid)
      .expect(201);
    expect(res.body.user.privacyAckAt).toMatch(/^\d{4}-/);
    const user = await User.findOne({ username: valid.username });
    expect(user?.privacyAckAt).toBeInstanceOf(Date);
  });

  it("privacyAckAt on the account -> cookie on login from a new device; absent otherwise", async () => {
    const { res: plain } = await registered();
    expect(cookieHeader(plain)).not.toMatch(PRIVACY_ACK_COOKIE);
    await User.updateOne({ username: valid.username }, { privacyAckAt: new Date() });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: valid.username, password: valid.password })
      .expect(200);
    const set = cookieHeader(res);
    expect(set).toMatch(new RegExp(`${PRIVACY_ACK_COOKIE}=1`));
    // The banner is dismissed client-side from this cookie, so it is readable by scripts.
    const ack = ((res.headers["set-cookie"] as unknown as string[]) ?? []).find((c) =>
      c.startsWith(PRIVACY_ACK_COOKIE),
    )!;
    expect(ack).not.toMatch(/HttpOnly/);
    expect(ack).toMatch(/Max-Age=31536000/);
  });

  it("cookie at login sets privacyAckAt once and never overwrites an earlier acknowledgment", async () => {
    await registered();
    const earlier = new Date("2026-01-01T00:00:00Z");
    await User.updateOne({ username: valid.username }, { privacyAckAt: earlier });
    const res = await request(app)
      .post("/api/auth/login")
      .set("Cookie", `${PRIVACY_ACK_COOKIE}=1`)
      .send({ username: valid.username, password: valid.password })
      .expect(200);
    expect(res.body.user.privacyAckAt).toBe(earlier.toISOString());
  });
});

describe("PUT /api/users/me/active-role", () => {
  it("switches to a held role and mirrors it in the session; refuses a role not held", async () => {
    const { agent } = await registered();
    const denied = await agent.put("/api/users/me/active-role").send({ role: "admin" }).expect(403);
    expect(denied.body.error).toBe("forbidden");
    await User.updateOne({ username: valid.username }, { roles: ["member", "curator"] });
    const ok = await agent.put("/api/users/me/active-role").send({ role: "curator" }).expect(200);
    expect(MeResponse.parse(ok.body).user.activeRole).toBe("curator");
    const user = await User.findOne({ username: valid.username });
    expect(user?.activeRole).toBe("curator");
    const sessions = await mongoose.connection.db!.collection("sessions").find({}).toArray();
    expect(sessions[0].session.activeRole).toBe("curator");
    const bad = await agent.put("/api/users/me/active-role").send({ role: "coach" }).expect(400);
    expect(bad.body.error).toBe("validation_error");
  });

  it("requires a session", async () => {
    await request(app).put("/api/users/me/active-role").send({ role: "member" }).expect(401);
  });
});

describe("requireRole", () => {
  // A throwaway app so the production router gains no test-only route.
  const probe = express();
  probe.use(express.json());
  probe.use(requireDb, sessionMiddleware());
  probe.use("/api/auth", authRouter);
  probe.get("/probe/admin", ...requireAuth, requireRole("admin"), (_req, res) =>
    res.json({ ok: true }),
  );
  probe.use(errorHandler);

  it("is 403 forbidden for a member, 401 without a session, 200 once the role is held", async () => {
    await request(probe).get("/probe/admin").expect(401);
    const agent = request.agent(probe);
    await agent.post("/api/auth/register").send(valid).expect(201);
    const denied = await agent.get("/probe/admin").expect(403);
    expect(denied.body).toEqual({ error: "forbidden" });
    // Holding the role is what counts, not the active view (design doc, Role rules).
    await User.updateOne({ username: valid.username }, { roles: ["member", "admin"] });
    const me = await agent.get("/api/auth/me").expect(200);
    expect(me.body.user.activeRole).toBe("member");
    await agent.get("/probe/admin").expect(200);
  });
});
