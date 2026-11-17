import mongoose from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import app from "../src/app.js";
import {
  AdminProfile,
  CuratorProfile,
  LogEntry,
  MemberProfile,
  User,
} from "../src/models/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});
// T21: Admin account management (design doc REST table, D18): list and filter, inspect account fields,
// suspend and reactivate, delete with the T5 cascade; and the Curator and Admin role profiles.

const PASSWORD = "correct horse battery";

async function make(username: string, roles: string[] = ["member"]) {
  const agent = request.agent(app);
  await agent
    .post("/api/auth/register")
    .send({ username, email: `${username}@example.com`, password: PASSWORD, timezone: "UTC" })
    .expect(201);
  const user = (await User.findOne({ username }))!;
  if (roles.length > 1) {
    await User.updateOne({ _id: user._id }, { $set: { roles } });
    if (roles.includes("curator")) await CuratorProfile.create({ userId: user._id });
    if (roles.includes("admin")) await AdminProfile.create({ userId: user._id });
  }
  return { agent, user };
}

const grants = async (userId: mongoose.Types.ObjectId) =>
  (await AdminProfile.findOne({ userId }).lean())?.grantsCount ?? 0;

const sessionsOf = (userId: unknown) =>
  mongoose.connection
    .db!.collection("sessions")
    .countDocuments({ "session.userId": String(userId) });

describe("admin route guards", () => {
  // Value: protects=the T21 done-when guard (a curator cannot manage accounts); fails_when=adminRouter
  //   loses requireRole("admin"); why_new=only the roles route was guarded before, now four more ride
  //   on the router-level guard; seam=none; no_claim=page redirects
  it("is 401 without a session and 403 for a member or a curator on every admin route", async () => {
    await make("mia");
    await request(app).get("/api/admin/users").expect(401);
    const { agent: curator } = await make("cleo", ["member", "curator"]);
    await curator
      .put("/api/admin/users/mia/roles")
      .send({ roles: ["member", "curator"] })
      .expect(403);
    await curator.get("/api/admin/users").expect(403);
    await curator.get("/api/admin/users/mia").expect(403);
    await curator.put("/api/admin/users/mia/status").send({ status: "suspended" }).expect(403);
    await curator.delete("/api/admin/users/mia").expect(403);
    const { agent: member } = await make("max");
    await member.get("/api/admin/users").expect(403);
    expect(await User.countDocuments({ username: "mia", status: "active" })).toBe(1);
  });
});

describe("GET /api/admin/users", () => {
  it("lists accounts by username with role, status and prefix filters and 20 per page", async () => {
    const { agent } = await make("adam", ["member", "admin"]);
    await make("cleo", ["member", "curator"]);
    for (let i = 0; i < 21; i++)
      await User.create({
        username: `user_${String(i).padStart(2, "0")}`,
        email: `u${i}@example.org`,
        passwordHash: "x",
      });
    await User.updateOne({ username: "user_03" }, { $set: { status: "suspended" } });

    const first = await agent.get("/api/admin/users").expect(200);
    expect(first.body).toMatchObject({ page: 1, pageSize: 20, total: 23 });
    expect(first.body.users[0]).toEqual({
      username: "adam",
      email: "adam@example.com",
      roles: ["member", "admin"],
      status: "active",
      activeRole: "member",
      deletionPending: false,
      createdAt: expect.any(String),
    });
    expect(first.body.users[0]).not.toHaveProperty("passwordHash");
    const second = await agent.get("/api/admin/users?page=2").expect(200);
    expect(second.body.users.map((u: { username: string }) => u.username)).toEqual([
      "user_18",
      "user_19",
      "user_20",
    ]);

    const curators = await agent.get("/api/admin/users?role=curator").expect(200);
    expect(curators.body.users.map((u: { username: string }) => u.username)).toEqual(["cleo"]);
    const suspended = await agent.get("/api/admin/users?status=suspended").expect(200);
    expect(suspended.body.users.map((u: { username: string }) => u.username)).toEqual(["user_03"]);
    const byPrefix = await agent.get("/api/admin/users?q=USER_1").expect(200);
    expect(byPrefix.body.total).toBe(10);
    const byEmail = await agent.get("/api/admin/users?q=u2%40").expect(200);
    expect(byEmail.body.users.map((u: { username: string }) => u.username)).toEqual(["user_02"]);
    // Regex characters in q are literal, not a pattern.
    expect((await agent.get("/api/admin/users?q=.*").expect(200)).body.total).toBe(0);
    await agent.get("/api/admin/users?role=coach").expect(400);
    await agent.get("/api/admin/users?page=0").expect(400);
  });
});

describe("GET /api/admin/users/:username", () => {
  it("shows the account fields and which profiles exist, never logs; 404 for an unknown name", async () => {
    const { agent } = await make("adam", ["member", "admin"]);
    await make("cleo", ["member", "curator"]);
    const res = await agent.get("/api/admin/users/CLEO").expect(200);
    expect(res.body).toEqual({
      user: {
        username: "cleo",
        email: "cleo@example.com",
        roles: ["member", "curator"],
        status: "active",
        activeRole: "member",
        deletionPending: false,
        privacyAckAt: null,
        createdAt: expect.any(String),
      },
      profiles: { member: true, curator: true, admin: false },
    });
    await agent.get("/api/admin/users/nobody").expect(404);
  });
});

describe("PUT /api/admin/users/:username/status", () => {
  // Value: protects=the T21 done-when (a suspended account cannot log in) and that suspension ends
  //   sessions at once; fails_when=the status write or the session sweep is dropped; why_new=no route
  //   could suspend before; seam=none; no_claim=the login check itself (auth.test.ts covers it)
  it("suspends: login answers 403, open sessions end, and the change counts; reactivating restores login", async () => {
    const { agent, user: actor } = await make("adam", ["member", "admin"]);
    const { agent: mia, user } = await make("mia");
    expect(await sessionsOf(user._id)).toBe(1);

    const res = await agent
      .put("/api/admin/users/mia/status")
      .send({ status: "suspended" })
      .expect(200);
    expect(res.body.user.status).toBe("suspended");
    expect(await sessionsOf(user._id)).toBe(0);
    await mia.get("/api/auth/me").expect(401);
    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: "mia", password: PASSWORD })
      .expect(403);
    expect(login.body).toEqual({ error: "account_suspended" });
    expect(await grants(actor._id)).toBe(1);

    // Setting the status it already has changes nothing and is not counted.
    await agent.put("/api/admin/users/mia/status").send({ status: "suspended" }).expect(200);
    expect(await grants(actor._id)).toBe(1);

    await agent.put("/api/admin/users/mia/status").send({ status: "active" }).expect(200);
    await request(app)
      .post("/api/auth/login")
      .send({ username: "mia", password: PASSWORD })
      .expect(200);
    expect(await grants(actor._id)).toBe(2);
  });

  it("refuses to suspend yourself and validates the status; another Admin can suspend and reactivate you", async () => {
    const { agent } = await make("adam", ["member", "admin"]);
    const { agent: other } = await make("ada", ["member", "admin"]);
    const self = await agent
      .put("/api/admin/users/adam/status")
      .send({ status: "suspended" })
      .expect(409);
    expect(self.body).toEqual({ error: "cannot_suspend_self" });
    await agent.put("/api/admin/users/adam/status").send({ status: "gone" }).expect(400);
    expect((await User.findOne({ username: "adam" }).lean())?.status).toBe("active");

    await other.put("/api/admin/users/adam/status").send({ status: "suspended" }).expect(200);
    await agent.get("/api/admin/users").expect(401); // adam's session ended
    await other.put("/api/admin/users/adam/status").send({ status: "active" }).expect(200);
    await request(app)
      .post("/api/auth/login")
      .send({ username: "adam", password: PASSWORD })
      .expect(200);
  });

  it("puts the account back and answers 409 last_admin when two Admins suspend each other at once", async () => {
    const { agent } = await make("adam", ["member", "admin"]);
    await make("ada", ["member", "admin"]);
    // ada is suspended by someone else between the guard and the write: after the write no usable
    // Admin would remain, so this suspension is undone.
    const original = User.updateOne.bind(User);
    let raced = false;
    vi.spyOn(User, "updateOne").mockImplementation(((filter: never, update: never, opts: never) => {
      if (!raced) {
        raced = true;
        return original({ username: "adam" }, { $set: { status: "suspended" } }).then(() =>
          original(filter, update, opts),
        );
      }
      return original(filter, update, opts);
    }) as never);
    const res = await agent.put("/api/admin/users/ada/status").send({ status: "suspended" });
    vi.restoreAllMocks();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "last_admin" });
    expect((await User.findOne({ username: "ada" }).lean())?.status).toBe("active");
  });
});

describe("DELETE /api/admin/users/:username", () => {
  it("deletes the account and everything it owns with the T5 cascade, and counts the change", async () => {
    const { agent, user: actor } = await make("adam", ["member", "admin"]);
    const { user } = await make("cleo", ["member", "curator"]);
    await LogEntry.create({
      userId: user._id,
      date: "2026-11-16",
      meal: "lunch",
      fdcId: 1,
      grams: 100,
      source: "search",
      confidence: 1,
    });
    expect(await LogEntry.countDocuments({ userId: user._id })).toBe(1);
    await agent.delete("/api/admin/users/cleo").expect(204);
    expect(await User.countDocuments({ _id: user._id })).toBe(0);
    expect(await MemberProfile.countDocuments({ userId: user._id })).toBe(0);
    expect(await CuratorProfile.countDocuments({ userId: user._id })).toBe(0);
    expect(await LogEntry.countDocuments({ userId: user._id })).toBe(0);
    expect(await sessionsOf(user._id)).toBe(0);
    expect(await grants(actor._id)).toBe(1);
    await agent.delete("/api/admin/users/cleo").expect(404);
  });

  it("refuses to delete yourself: an Admin deletes their own account through DELETE /api/users/me", async () => {
    const { agent } = await make("adam", ["member", "admin"]);
    await make("ada", ["member", "admin"]);
    const self = await agent.delete("/api/admin/users/adam").expect(409);
    expect(self.body).toEqual({ error: "cannot_delete_self" });
    expect(await User.countDocuments({ username: "adam" })).toBe(1);
  });

  it("retries a cascade that failed part way once, and a second failure leaves the account locked", async () => {
    const { agent } = await make("adam", ["member", "admin"]);
    const { user } = await make("mia");
    const original = MemberProfile.deleteMany.bind(MemberProfile);
    const spy = vi
      .spyOn(MemberProfile, "deleteMany")
      .mockImplementationOnce((() => Promise.reject(new Error("network"))) as never);
    await agent.delete("/api/admin/users/mia").expect(204);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await User.countDocuments({ _id: user._id })).toBe(0);

    const { user: max } = await make("max");
    spy.mockReset().mockImplementation((() => Promise.reject(new Error("network"))) as never);
    await agent.delete("/api/admin/users/max").expect(500);
    expect((await User.findById(max._id).lean())?.deletionPending).toBe(true);
    spy.mockImplementation(original as never);
    await agent.delete("/api/admin/users/max").expect(204);
    expect(await User.countDocuments({ _id: max._id })).toBe(0);
  });
});

describe("GET and PUT /api/users/me/profiles/:kind", () => {
  it("a curator reads and edits their profile; the counters stay server-written", async () => {
    const { agent } = await make("cleo", ["member", "curator"]);
    const empty = await agent.get("/api/users/me/profiles/curator").expect(200);
    expect(empty.body).toEqual({
      kind: "curator",
      credentials: null,
      bio: null,
      specialties: [],
      publicListing: false,
      editsCount: 0,
      lastEditAt: null,
    });
    const res = await agent
      .put("/api/users/me/profiles/curator")
      .send({
        credentials: "RD",
        bio: "Dairy-free cook",
        specialties: ["dairy"],
        publicListing: true,
      })
      .expect(200);
    expect(res.body).toMatchObject({
      credentials: "RD",
      specialties: ["dairy"],
      publicListing: true,
    });
    const cleared = await agent
      .put("/api/users/me/profiles/curator")
      .send({ credentials: null })
      .expect(200);
    expect(cleared.body).toMatchObject({ credentials: null, bio: "Dairy-free cook" });
    // Value: protects=an empty string clears a profile field like null does; fails_when=the "" branch
    //   of changes() is dropped and "" is stored; why_new=only null was sent; seam=none; no_claim=none
    //   beyond protects
    const blanked = await agent
      .put("/api/users/me/profiles/curator")
      .send({ bio: "  " })
      .expect(200);
    expect(blanked.body).toMatchObject({ bio: null, publicListing: true });
    await agent.put("/api/users/me/profiles/curator").send({ editsCount: 99 }).expect(400);
    await agent
      .put("/api/users/me/profiles/curator")
      .send({ specialties: ["Dairy", "dairy"] })
      .expect(400);
    expect((await CuratorProfile.findOne({}).lean())?.editsCount).toBe(0);
  });

  // Value: protects=a held role whose profile document is missing reads as empty and the first edit
  //   creates it; fails_when=updateProfile loses upsert (the edit is silently dropped) or getProfile
  //   throws on a missing doc; why_new=every other test creates the profile first; seam=none;
  //   no_claim=how a profile goes missing (grant upserts it, roles.test.ts)
  it("reads a missing role profile as empty and creates it on the first edit", async () => {
    const { agent, user } = await make("cleo");
    await User.updateOne({ _id: user._id }, { $set: { roles: ["member", "curator"] } });
    expect(await CuratorProfile.countDocuments({ userId: user._id })).toBe(0);
    const empty = await agent.get("/api/users/me/profiles/curator").expect(200);
    expect(empty.body).toMatchObject({ bio: null, specialties: [], editsCount: 0 });
    const res = await agent
      .put("/api/users/me/profiles/curator")
      .send({ bio: "Gluten-free baker" })
      .expect(200);
    expect(res.body).toMatchObject({ bio: "Gluten-free baker", editsCount: 0 });
    const stored = await CuratorProfile.findOne({ userId: user._id }).lean();
    expect(stored?.bio).toBe("Gluten-free baker");
  });

  it("an admin edits their private note; a role not held is 403 and member or unknown kinds are 400", async () => {
    const { agent } = await make("adam", ["member", "admin"]);
    const res = await agent
      .put("/api/users/me/profiles/admin")
      .send({ internalNote: "on call this week" })
      .expect(200);
    expect(res.body).toEqual({
      kind: "admin",
      grantsCount: 0,
      lastAuditAt: null,
      internalNote: "on call this week",
    });
    await agent.get("/api/users/me/profiles/curator").expect(403);
    await agent.put("/api/users/me/profiles/curator").send({ bio: "x" }).expect(403);
    await agent.get("/api/users/me/profiles/member").expect(400);
    await agent.get("/api/users/me/profiles/coach").expect(400);
    await request(app).get("/api/users/me/profiles/admin").expect(401);
  });
});
