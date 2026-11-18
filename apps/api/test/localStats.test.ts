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
    // Extended by /ship coverage audit (T28). Value: protects=the window is exactly the 7 UTC dates
    //   ending today; fails_when=the oldest date is dropped or a future-dated log is counted;
    //   why_new=only the day before the window was checked; seam=none; no_claim=non-UTC member timezones
    await log(lee._id, "2026-11-10", 10); // oldest day of the window: counted
    await log(miaUser._id, "2026-11-17", 70); // tomorrow in UTC: not counted
    await log(lee._id, "2026-11-16", 99, 12345); // another food

    const anon = FoodDetailsResponse.parse(
      (await request(app).get(`/api/foods/${FDC}`).expect(200)).body,
    );
    expect(anon.localStats).toEqual({
      logCount7d: 4,
      memberCount7d: 2,
      publicLoggers: null,
      myGrams7d: null,
    });

    const signedIn = FoodDetailsResponse.parse(
      (await mia.get(`/api/foods/${FDC}`).expect(200)).body,
    );
    expect(signedIn.localStats).toEqual({
      logCount7d: 4,
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
    expect(afterDelete.localStats.logCount7d).toBe(4);
  });

  // Value: protects=search stays session-free, so a signed-in search does not rewrite the rolling
  //   session (eng review OV7); fails_when=session middleware is mounted on the whole foods router;
  //   why_new=T28 adds a session read to details only; seam=none; no_claim=Vercel cookie handling
  it("reads the session on details only, not on search", async () => {
    const { agent } = await member("mia");
    const search = await agent.get("/api/foods/search?q=cheddar");
    expect(search.headers["set-cookie"]).toBeUndefined();
  });

  // Generated by /ship coverage audit (T28).
  // Value: protects=publicLoggers lists at most 10 active, non-deleting opted-in members sorted by
  //   username, [] when none, and a session whose account is gone gets the anonymous view;
  //   fails_when=the sort, the cap or the status/deletion filter is dropped, or a missing user 500s;
  //   why_new=the first test has one public logger only; seam=none; no_claim=web rendering (lane B #38)
  it("lists at most 10 active opted-in usernames in order and skips blocked members", async () => {
    const { agent, user: viewer } = await member("viewer");
    const empty = FoodDetailsResponse.parse(
      (await agent.get(`/api/foods/${FDC}`).expect(200)).body,
    );
    expect(empty.localStats).toEqual({
      logCount7d: 0,
      memberCount7d: 0,
      publicLoggers: [],
      myGrams7d: 0,
    });

    const names = Array.from({ length: 12 }, (_, i) => `u${String(12 - i).padStart(2, "0")}`);
    const extra = [
      { username: "aa_suspended", status: "suspended" as const },
      { username: "ab_leaving", deletionPending: true },
    ];
    for (const fields of [...names.map((username) => ({ username })), ...extra]) {
      const u = await User.create({
        ...fields,
        email: `${fields.username}@example.com`,
        passwordHash: "unused",
      });
      await MemberProfile.create({ userId: u._id, publicLogs: true });
      await log(u._id, "2026-11-14", 10);
    }

    const body = FoodDetailsResponse.parse((await agent.get(`/api/foods/${FDC}`).expect(200)).body);
    expect(body.localStats).toEqual({
      logCount7d: 14,
      memberCount7d: 14,
      publicLoggers: ["u01", "u02", "u03", "u04", "u05", "u06", "u07", "u08", "u09", "u10"],
      myGrams7d: 0,
    });

    await User.deleteOne({ _id: viewer._id });
    const gone = FoodDetailsResponse.parse((await agent.get(`/api/foods/${FDC}`).expect(200)).body);
    expect(gone.localStats).toMatchObject({ publicLoggers: null, myGrams7d: null });
  });

  it("has the {fdcId, date} index", async () => {
    await LogEntry.init();
    const indexes = await mongoose.connection.db!.collection("logentries").indexes();
    expect(
      indexes.some((i) => JSON.stringify(i.key) === JSON.stringify({ fdcId: 1, date: 1 })),
    ).toBe(true);
  });
});
