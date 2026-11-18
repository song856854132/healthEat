import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { FoodDetailsResponse } from "@healtheat/shared";
import mongoose, { type Types } from "mongoose";
import app from "../src/app.js";
import { LogEntry, MemberProfile, User } from "../src/models/index.js";

// T28: local data on GET /api/foods/:fdcId (design doc Pages table, Details; issue #39; eng review D6).

const CHEDDAR = JSON.parse(
  readFileSync(new URL("./fixtures/usda/food-branded-cheddar.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const FDC = 2095236;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(CHEDDAR), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function member(username: string, publicLogs = false) {
  const agent = request.agent(app);
  await agent
    .post("/api/auth/register")
    .send({
      username,
      email: `${username}@example.com`,
      password: "correct horse battery",
      timezone: "UTC",
    })
    .expect(201);
  const user = (await User.findOne({ username }))!;
  if (publicLogs)
    await MemberProfile.updateOne({ userId: user._id }, { $set: { publicLogs: true } });
  return { agent, user };
}
const log = (userId: Types.ObjectId, date: string, grams: number, fdcId = FDC) =>
  LogEntry.create({ userId, date, meal: "lunch", fdcId, grams, source: "search", confidence: 1 });

describe("GET /api/foods/:fdcId localStats", () => {
  // Value: protects=everyone sees this week's counts, only signed-in callers see opted-in usernames and
  //   their own grams, and private or blocked members never appear; fails_when=usernames reach anonymous
  //   callers, private members are listed, or a suspended session sees signed-in data; why_new=new field
  //   (#39); seam=none; no_claim=web rendering (lane B #38)
  it("shows counts to everyone and opted-in usernames and own grams only to signed-in callers", async () => {
    const { agent: mia, user: miaUser } = await member("mia", true);
    const { user: lee } = await member("lee"); // private
    const { agent: sam, user: samUser } = await member("sam", true);
    await log(miaUser._id, "2026-11-16", 30);
    await log(miaUser._id, "2026-11-12", 20);
    await log(lee._id, "2026-11-15", 50);
    await log(samUser._id, "2026-11-09", 40); // last week: not counted
    await log(lee._id, "2026-11-16", 99, 12345); // another food

    const anon = FoodDetailsResponse.parse(
      (await request(app).get(`/api/foods/${FDC}`).expect(200)).body,
    );
    expect(anon.localStats).toEqual({
      logCount7d: 3,
      memberCount7d: 2,
      publicLoggers: null,
      myGrams7d: null,
    });

    const signedIn = FoodDetailsResponse.parse(
      (await mia.get(`/api/foods/${FDC}`).expect(200)).body,
    );
    expect(signedIn.localStats).toEqual({
      logCount7d: 3,
      memberCount7d: 2,
      publicLoggers: ["mia"],
      myGrams7d: 50,
    });

    const other = FoodDetailsResponse.parse((await sam.get(`/api/foods/${FDC}`).expect(200)).body);
    expect(other.localStats).toMatchObject({ publicLoggers: ["mia"], myGrams7d: 0 });

    await User.updateOne({ _id: samUser._id }, { $set: { status: "suspended" } });
    const blocked = FoodDetailsResponse.parse(
      (await sam.get(`/api/foods/${FDC}`).expect(200)).body,
    );
    expect(blocked.localStats).toMatchObject({ publicLoggers: null, myGrams7d: null });

    await User.updateOne({ _id: miaUser._id }, { $set: { deletionPending: true } });
    const afterDelete = FoodDetailsResponse.parse(
      (await request(app).get(`/api/foods/${FDC}`).expect(200)).body,
    );
    expect(afterDelete.localStats.logCount7d).toBe(3);
  });

  // Value: protects=search stays session-free, so a signed-in search does not rewrite the rolling
  //   session (eng review OV7); fails_when=session middleware is mounted on the whole foods router;
  //   why_new=T28 adds a session read to details only; seam=none; no_claim=Vercel cookie handling
  it("reads the session on details only, not on search", async () => {
    const { agent } = await member("mia");
    const search = await agent.get("/api/foods/search?q=cheddar");
    expect(search.headers["set-cookie"]).toBeUndefined();
  });

  it("has the {fdcId, date} index", async () => {
    await LogEntry.init();
    const indexes = await mongoose.connection.db!.collection("logentries").indexes();
    expect(
      indexes.some((i) => JSON.stringify(i.key) === JSON.stringify({ fdcId: 1, date: 1 })),
    ).toBe(true);
  });
});
