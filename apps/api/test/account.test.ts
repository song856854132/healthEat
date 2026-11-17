import mongoose from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import app from "../src/app.js";
import {
  AdminProfile,
  CuratorProfile,
  Food,
  LogEntry,
  MemberProfile,
  User,
  UserAllergen,
} from "../src/models/index.js";
import { deleteAccount } from "../src/services/account.js";

afterEach(() => {
  vi.restoreAllMocks();
});
// T5: the account deletion cascade (D6): flag first, then everything the account owns, then the User;
// every step rerunnable. Shared by self-delete and the Admin delete of T21.

const PASSWORD = "correct horse battery";

async function member(username: string) {
  const agent = request.agent(app);
  await agent
    .post("/api/auth/register")
    .send({ username, email: `${username}@example.com`, password: PASSWORD, timezone: "UTC" })
    .expect(201);
  return agent;
}

/** A member with a log entry, an allergen setting, all three role profiles and two sessions. */
async function fullAccount(username: string) {
  const agent = await member(username);
  await agent
    .put("/api/users/me/allergens")
    .send({ allergens: [{ key: "soy" }] })
    .expect(200);
  await Food.create({
    fdcId: 1,
    description: "TOFU",
    dataType: "Foundation",
    fetchedAt: new Date(),
    allergensMatchedAt: new Date(),
  });
  await agent.post("/api/users/me/logs").send({ fdcId: 1, grams: 100, meal: "lunch" }).expect(201);
  const user = (await User.findOne({ username }))!;
  await CuratorProfile.create({ userId: user._id });
  await AdminProfile.create({ userId: user._id });
  const second = request.agent(app);
  await second.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200);
  return { agent, second, user };
}

const sessionsOf = (userId: unknown) =>
  mongoose.connection
    .db!.collection("sessions")
    .countDocuments({ "session.userId": String(userId) });

async function owned(userId: mongoose.Types.ObjectId) {
  return {
    user: await User.countDocuments({ _id: userId }),
    logs: await LogEntry.countDocuments({ userId }),
    allergens: await UserAllergen.countDocuments({ userId }),
    member: await MemberProfile.countDocuments({ userId }),
    curator: await CuratorProfile.countDocuments({ userId }),
    admin: await AdminProfile.countDocuments({ userId }),
    sessions: await sessionsOf(userId),
  };
}

const EMPTY = { user: 0, logs: 0, allergens: 0, member: 0, curator: 0, admin: 0, sessions: 0 };

describe("DELETE /api/users/me", () => {
  it("deletes the account and every collection it owns, and ends every session", async () => {
    const { agent, second, user } = await fullAccount("dana");
    expect(await owned(user._id)).toEqual({
      user: 1,
      logs: 1,
      allergens: 1,
      member: 1,
      curator: 1,
      admin: 1,
      sessions: 2,
    });

    const res = await agent.delete("/api/users/me").expect(204);
    expect(String(res.headers["set-cookie"])).toMatch(/he_sid=;/);
    expect(await owned(user._id)).toEqual(EMPTY);
    await agent.get("/api/auth/me").expect(401);
    await second.get("/api/auth/me").expect(401);
    await request(app)
      .post("/api/auth/login")
      .send({ username: "dana", password: PASSWORD })
      .expect(401);
  });

  it("leaves other members' data alone", async () => {
    const { agent } = await fullAccount("dana");
    const other = await member("eli");
    await other
      .put("/api/users/me/allergens")
      .send({ allergens: [{ key: "milk" }] })
      .expect(200);
    await other
      .post("/api/users/me/logs")
      .send({ fdcId: 1, grams: 50, meal: "dinner" })
      .expect(201);
    const eli = (await User.findOne({ username: "eli" }))!;

    await agent.delete("/api/users/me").expect(204);
    expect(await owned(eli._id)).toEqual({
      user: 1,
      logs: 1,
      allergens: 1,
      member: 1,
      curator: 0,
      admin: 0,
      sessions: 1,
    });
    await other.get("/api/users/me/logs").expect(200);
  });

  // Value: protects=the deployment always keeps an Admin: the only Admin cannot self-delete;
  //   fails_when=the last_admin guard on DELETE /me is removed; why_new=roles.test.ts guards role
  //   writes only; seam=none; no_claim=two last admins deleting at the same instant (not raced here)
  it("refuses the only Admin with 409 last_admin and writes nothing, but lets an Admin go when another remains", async () => {
    const { agent, user } = await fullAccount("dana");
    await User.updateOne({ _id: user._id }, { $set: { roles: ["member", "admin"] } });
    const res = await agent.delete("/api/users/me").expect(409);
    expect(res.body.error).toBe("last_admin");
    expect(await owned(user._id)).toMatchObject({ user: 1, logs: 1, allergens: 1, sessions: 2 });
    expect((await User.findById(user._id).lean())?.deletionPending).toBe(false);

    await member("eli");
    await User.updateOne({ username: "eli" }, { $set: { roles: ["member", "admin"] } });
    await agent.delete("/api/users/me").expect(204);
    expect(await owned(user._id)).toEqual(EMPTY);
  });

  it("is 401 without a session", async () => {
    await request(app).delete("/api/users/me").expect(401);
  });

  it("retries the cascade once when a step fails, so one blip still deletes everything", async () => {
    const { agent, user } = await fullAccount("dana");
    vi.spyOn(UserAllergen, "deleteMany").mockRejectedValueOnce(new Error("network blip"));
    await agent.delete("/api/users/me").expect(204);
    expect(await owned(user._id)).toEqual(EMPTY);
  });

  it("locks a half-deleted account, and the member's next login with the right password finishes it", async () => {
    const { agent, user } = await fullAccount("dana");
    vi.spyOn(UserAllergen, "deleteMany")
      .mockRejectedValueOnce(new Error("network blip"))
      .mockRejectedValueOnce(new Error("network blip"));
    await agent.delete("/api/users/me").expect(500);

    expect(await owned(user._id)).toMatchObject({ user: 1, logs: 0, allergens: 1 });
    expect((await User.findById(user._id).lean())?.deletionPending).toBe(true);
    // The flag alone locks the account: the session is refused, and so is a login with a wrong password.
    await agent.get("/api/users/me/logs").expect(403);
    await request(app)
      .post("/api/auth/login")
      .send({ username: "dana", password: "wrong password!" })
      .expect(401);
    expect(await owned(user._id)).toMatchObject({ user: 1, allergens: 1 });

    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: "dana", password: PASSWORD })
      .expect(403);
    expect(login.body.error).toBe("account_deletion_pending");
    expect(await owned(user._id)).toEqual(EMPTY);
  });

  it("refuses an Admin whose only fellow Admin is being deleted or suspended", async () => {
    const { agent, user } = await fullAccount("dana");
    await User.updateOne({ _id: user._id }, { $set: { roles: ["member", "admin"] } });
    await member("eli");
    await User.updateOne(
      { username: "eli" },
      { $set: { roles: ["member", "admin"], deletionPending: true } },
    );
    await member("fay");
    await User.updateOne(
      { username: "fay" },
      { $set: { roles: ["member", "admin"], status: "suspended" } },
    );
    expect((await agent.delete("/api/users/me").expect(409)).body.error).toBe("last_admin");
    expect((await User.findById(user._id).lean())?.deletionPending).toBe(false);
  });

  it("clears its own flag and refuses when the other Admin went at the same moment", async () => {
    const { user } = await fullAccount("dana");
    await User.updateOne({ _id: user._id }, { $set: { roles: ["member", "admin"] } });
    await member("eli");
    await User.updateOne({ username: "eli" }, { $set: { roles: ["member", "admin"] } });
    // The other Admin is flagged between this delete's first check and its own flag.
    const real = User.updateOne.bind(User);
    vi.spyOn(User, "updateOne").mockImplementationOnce((async (
      ...args: Parameters<typeof real>
    ) => {
      await real({ username: "eli" }, { $set: { deletionPending: true } });
      return real(...args);
    }) as typeof User.updateOne);
    await expect(deleteAccount(user._id, { keepAnAdmin: true })).rejects.toMatchObject({
      status: 409,
    });
    expect((await User.findById(user._id).lean())?.deletionPending).toBe(false);
    expect(await owned(user._id)).toMatchObject({ user: 1, logs: 1 });
  });
});

describe("deleteAccount", () => {
  it("sweeps a log entry written after its first delete, once the User is gone", async () => {
    const { user } = await fullAccount("dana");
    const real = User.deleteOne.bind(User);
    vi.spyOn(User, "deleteOne").mockImplementationOnce(((...args: Parameters<typeof real>) => {
      // A request that passed requireAuth before the flag writes now.
      return LogEntry.create({
        userId: user._id,
        date: "2026-11-16",
        meal: "lunch",
        fdcId: 1,
        grams: 10,
        source: "search",
        confidence: 1,
      }).then(() => real(...args));
    }) as typeof User.deleteOne);
    await deleteAccount(user._id);
    expect(await owned(user._id)).toEqual(EMPTY);
  });

  it("is a no-op for an account that is already gone", async () => {
    const { user } = await fullAccount("dana");
    await deleteAccount(user._id);
    await expect(deleteAccount(user._id)).resolves.toBeUndefined();
    expect(await owned(user._id)).toEqual(EMPTY);
  });
});
