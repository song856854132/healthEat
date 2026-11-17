import mongoose from "mongoose";
import { describe, expect, it, vi } from "vitest";
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

  it("is 401 without a session", async () => {
    await request(app).delete("/api/users/me").expect(401);
  });

  it("refuses login once flagged after a crash part way, and a rerun of the cascade finishes it", async () => {
    const { agent, user } = await fullAccount("dana");
    vi.spyOn(UserAllergen, "deleteMany").mockRejectedValueOnce(new Error("network blip"));
    await agent.delete("/api/users/me").expect(500);

    const half = await owned(user._id);
    expect(half).toMatchObject({ user: 1, logs: 0, allergens: 1 });
    expect((await User.findById(user._id).lean())?.deletionPending).toBe(true);
    // The flag alone locks the account: login is refused after the password matched, the session too.
    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: "dana", password: PASSWORD })
      .expect(403);
    expect(login.body.error).toBe("account_deletion_pending");
    await agent.get("/api/users/me/logs").expect(403);

    await deleteAccount(user._id);
    expect(await owned(user._id)).toEqual(EMPTY);
  });
});

describe("deleteAccount", () => {
  it("is a no-op for an account that is already gone", async () => {
    const { user } = await fullAccount("dana");
    await deleteAccount(user._id);
    await expect(deleteAccount(user._id)).resolves.toBeUndefined();
    expect(await owned(user._id)).toEqual(EMPTY);
  });
});
