import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../src/app.js";
import { AdminProfile, CuratorProfile, User } from "../src/models/index.js";
import { setRoles } from "../src/services/roles.js";

const password = "correct horse battery";
const account = (username: string) => ({
  username,
  email: `${username}@example.com`,
  password,
  timezone: "UTC",
});

async function registerAgent(username: string) {
  const agent = request.agent(app);
  // A listed username cannot register (409 username_reserved): create it unlisted, then list it and log
  // in, which is the owner's documented procedure.
  const listed = process.env.ADMIN_USERNAMES;
  const isListed = (listed ?? "")
    .split(",")
    .map((u) => u.trim().toLowerCase())
    .includes(username);
  if (isListed) delete process.env.ADMIN_USERNAMES;
  let res = await agent.post("/api/auth/register").send(account(username)).expect(201);
  if (isListed) {
    process.env.ADMIN_USERNAMES = listed;
    res = await agent.post("/api/auth/login").send({ username, password }).expect(200);
  }
  return { agent, res };
}

beforeEach(() => {
  process.env.ADMIN_USERNAMES = " Demo_Admin , other_admin ,";
});
afterEach(() => {
  delete process.env.ADMIN_USERNAMES;
});

describe("ADMIN_USERNAMES bootstrap (D10)", () => {
  // Value: protects=a listed ADMIN_USERNAMES name can never be claimed through open registration (the
  //   squatting path to admin); fails_when=register() stops checking the list or grants admin itself;
  //   why_new=the earlier bootstrap test registered the listed name directly; seam=none;
  //   no_claim=accounts created by other means (none exist before T7's seed)
  it("a listed username cannot register (409 username_reserved) and nothing is created", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send(account("demo_admin"))
      .expect(409);
    expect(res.body).toEqual({ error: "username_reserved" });
    expect(await User.countDocuments({ username: "demo_admin" })).toBe(0);
    expect(await AdminProfile.countDocuments()).toBe(0);
  });

  it("an existing account becomes admin with an AdminProfile at its next login once listed; others stay member", async () => {
    const { res } = await registerAgent("demo_admin");
    expect(res.body.user.roles).toEqual(["member", "admin"]);
    expect(res.body.profiles).toEqual({ member: true, curator: false, admin: true });
    const plain = await registerAgent("plain_member");
    expect(plain.res.body.user.roles).toEqual(["member"]);
    expect(await AdminProfile.countDocuments()).toBe(1);
  });

  it("the list is authoritative: a revoked listed admin regains admin at the next login", async () => {
    await registerAgent("demo_admin");
    await User.updateOne({ username: "demo_admin" }, { roles: ["member"], activeRole: "member" });
    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: "demo_admin", password })
      .expect(200);
    expect(login.body.user.roles).toContain("admin");
    expect(await AdminProfile.countDocuments()).toBe(1);
  });

  it("an existing account added to the list later becomes admin at its next login", async () => {
    delete process.env.ADMIN_USERNAMES;
    await registerAgent("late_admin");
    process.env.ADMIN_USERNAMES = "late_admin";
    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: "late_admin", password })
      .expect(200);
    expect(login.body.user.roles).toEqual(["member", "admin"]);
  });
});

describe("PUT /api/admin/users/:username/roles", () => {
  it("grants curator: profile upserted, grantsCount counted, the target sees it", async () => {
    const { agent: admin } = await registerAgent("demo_admin");
    const { agent: target } = await registerAgent("cara");
    const res = await admin
      .put("/api/admin/users/cara/roles")
      .send({ roles: ["member", "curator"] })
      .expect(200);
    expect(res.body.user.roles).toEqual(["member", "curator"]);
    expect(res.body.profiles.curator).toBe(true);
    const adminUser = await User.findOne({ username: "demo_admin" });
    const ap = await AdminProfile.findOne({ userId: adminUser!._id });
    expect(ap?.grantsCount).toBe(1);
    expect(ap?.lastAuditAt).toBeInstanceOf(Date);
    const me = await target.get("/api/auth/me").expect(200);
    expect(me.body.user.roles).toEqual(["member", "curator"]);
  });

  it("revoking the active role resets activeRole to member on the User and the session; the profile stays", async () => {
    const { agent: admin } = await registerAgent("demo_admin");
    const { agent: target } = await registerAgent("cara");
    await admin
      .put("/api/admin/users/cara/roles")
      .send({ roles: ["member", "curator"] })
      .expect(200);
    await target.put("/api/users/me/active-role").send({ role: "curator" }).expect(200);
    const res = await admin
      .put("/api/admin/users/cara/roles")
      .send({ roles: ["member"] })
      .expect(200);
    expect(res.body.user).toMatchObject({ roles: ["member"], activeRole: "member" });
    const me = await target.get("/api/auth/me").expect(200);
    expect(me.body.user.activeRole).toBe("member");
    const sessions = await mongoose.connection.db!.collection("sessions").find({}).toArray();
    const cara = await User.findOne({ username: "cara" });
    const caraSession = sessions.find((s) => s.session.userId === cara!.id);
    expect(caraSession?.session.activeRole).toBe("member");
    expect(await CuratorProfile.countDocuments({ userId: cara!._id })).toBe(1);
    // The revoked role no longer passes requireRole-backed checks: switching back is refused.
    await target.put("/api/users/me/active-role").send({ role: "curator" }).expect(403);
  });

  it("answers 403 for a member, 401 without a session, 404 for an unknown user, 400 without member", async () => {
    await registerAgent("cara");
    const { agent: member } = await registerAgent("plain_member");
    const denied = await member
      .put("/api/admin/users/cara/roles")
      .send({ roles: ["member", "admin"] })
      .expect(403);
    expect(denied.body).toEqual({ error: "forbidden" });
    await request(app)
      .put("/api/admin/users/cara/roles")
      .send({ roles: ["member"] })
      .expect(401);
    const { agent: admin } = await registerAgent("demo_admin");
    const missing = await admin
      .put("/api/admin/users/nobody_here/roles")
      .send({ roles: ["member"] })
      .expect(404);
    expect(missing.body).toEqual({ error: "not_found" });
    const bad = await admin
      .put("/api/admin/users/cara/roles")
      .send({ roles: ["curator"] })
      .expect(400);
    expect(bad.body.error).toBe("validation_error");
    expect((await User.findOne({ username: "cara" }))?.roles).toEqual(["member"]);
  });

  it("an admin cannot remove their own admin role (no lockout)", async () => {
    const { agent: admin } = await registerAgent("demo_admin");
    const res = await admin
      .put("/api/admin/users/demo_admin/roles")
      .send({ roles: ["member"] })
      .expect(409);
    expect(res.body).toEqual({ error: "cannot_revoke_own_admin" });
    // Granting themselves curator is fine and counted.
    const ok = await admin
      .put("/api/admin/users/demo_admin/roles")
      .send({ roles: ["member", "admin", "curator"] })
      .expect(200);
    expect(ok.body.user.roles).toEqual(["member", "admin", "curator"]);
  });

  it("an admin can grant admin to another account, which can then use the route", async () => {
    const { agent: admin } = await registerAgent("demo_admin");
    const { agent: second } = await registerAgent("dana");
    await admin
      .put("/api/admin/users/dana/roles")
      .send({ roles: ["member", "admin"] })
      .expect(200);
    await second
      .put("/api/admin/users/demo_admin/roles")
      .send({ roles: ["member", "admin", "curator"] })
      .expect(200);
    const unchanged = await admin
      .put("/api/admin/users/dana/roles")
      .send({ roles: ["member", "admin"] })
      .expect(200);
    expect(unchanged.body.user.roles).toEqual(["member", "admin"]);
    const adminUser = await User.findOne({ username: "demo_admin" });
    expect((await AdminProfile.findOne({ userId: adminUser!._id }))?.grantsCount).toBe(1);
  });
});

describe("PUT /api/admin/users/:username/roles: admin revocation and lookup", () => {
  // Value: protects=revoking admin from another admin cuts that account's admin-route access on its very
  // next request and resets an active admin view to member; fails_when=revokeRole special-cases admin
  // like member, or admin access is read from a cached session copy instead of the User document;
  // why_new=existing revoke coverage only revokes curator and checks the active-role switch, never the
  // requireRole("admin") gate after a revoke; seam=none; no_claim=a listed ADMIN_USERNAMES account,
  // which regains admin at its next login by design.
  it("revoking admin from another admin denies its next admin request and resets its active role", async () => {
    const { agent: admin } = await registerAgent("demo_admin");
    const { agent: second } = await registerAgent("dana");
    await admin
      .put("/api/admin/users/dana/roles")
      .send({ roles: ["member", "admin"] })
      .expect(200);
    await second.put("/api/users/me/active-role").send({ role: "admin" }).expect(200);
    const res = await admin
      .put("/api/admin/users/dana/roles")
      .send({ roles: ["member"] })
      .expect(200);
    expect(res.body.user).toMatchObject({ roles: ["member"], activeRole: "member" });
    const denied = await second
      .put("/api/admin/users/demo_admin/roles")
      .send({ roles: ["member", "admin"] })
      .expect(403);
    expect(denied.body).toEqual({ error: "forbidden" });
    const me = await second.get("/api/auth/me").expect(200);
    expect(me.body.user.activeRole).toBe("member");
  });

  // Value: protects=the target username in the path is matched case-insensitively, like login;
  // fails_when=the route stops lowercasing req.params.username and a mixed-case name answers 404;
  // why_new=every existing route call uses an all-lowercase path; seam=none; no_claim=usernames with
  // characters outside USERNAME_PATTERN.
  it("matches the target username case-insensitively", async () => {
    const { agent: admin } = await registerAgent("demo_admin");
    await registerAgent("cara");
    const res = await admin
      .put("/api/admin/users/CaRa/roles")
      .send({ roles: ["member", "curator"] })
      .expect(200);
    expect(res.body.user).toMatchObject({ username: "cara", roles: ["member", "curator"] });
  });
});

describe("role writes under concurrency (setRoles)", () => {
  // Value: protects=a role write based on a stale read is refused (409 roles_changed) instead of
  //   duplicating a role or overwriting another admin's change; fails_when=setRoles goes back to
  //   load-mutate-save or drops the roles filter from its conditional update; why_new=the route tests
  //   only ever act on fresh documents; seam=none; no_claim=true parallel requests (two stale loads are
  //   the deterministic stand-in for the race)
  it("a write from a stale read answers 409 roles_changed and leaves one copy of each role", async () => {
    await registerAgent("demo_admin");
    await registerAgent("cara");
    const actor = (await User.findOne({ username: "demo_admin" }))!;
    const staleA = (await User.findOne({ username: "cara" }))!;
    const staleB = (await User.findOne({ username: "cara" }))!;
    await setRoles(actor, staleA, ["member", "curator"]);
    await expect(setRoles(actor, staleB, ["member", "curator"])).rejects.toMatchObject({
      status: 409,
      code: "roles_changed",
    });
    expect((await User.findOne({ username: "cara" }))!.roles).toEqual(["member", "curator"]);
  });

  // Value: protects=no change may leave the deployment without an admin, even when the acting admin was
  //   demoted after loading; fails_when=the last_admin count is removed or ignores the target;
  //   why_new=self-revoke is the only lockout the route tests reach; seam=none; no_claim=the post-write
  //   compensation for two truly simultaneous demotions (needs interleaving the test cannot force)
  it("refuses to remove the last admin (409 last_admin)", async () => {
    await registerAgent("demo_admin");
    const { agent: dana } = await registerAgent("dana");
    const admin = (await User.findOne({ username: "demo_admin" }))!;
    const danaDoc = (await User.findOne({ username: "dana" }))!;
    await setRoles(admin, danaDoc, ["member", "admin"]);
    const staleDana = (await User.findOne({ username: "dana" }))!;
    // demo_admin is demoted elsewhere (e.g. removed from the list and revoked) before dana acts.
    await User.updateOne({ username: "demo_admin" }, { roles: ["member"], activeRole: "member" });
    const target = (await User.findOne({ username: "demo_admin" }))!;
    // dana is now the only admin; a request revoking dana's own admin is refused by the self rule,
    // and one demoting dana from a stale admin actor must be refused by the last-admin rule.
    await expect(setRoles(target, staleDana, ["member"])).rejects.toMatchObject({
      status: 409,
      code: "last_admin",
    });
    expect((await User.findOne({ username: "dana" }))!.roles).toContain("admin");
    await dana.get("/api/auth/me").expect(200);
  });
});
