import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { PublicHomeResponse } from "@healtheat/shared";
import app from "../src/app.js";
import {
  Allergen,
  CuratorProfile,
  Food,
  FoodAllergen,
  LogEntry,
  MemberProfile,
  PublicFeedSnapshot,
  User,
} from "../src/models/index.js";
import { loadDictionary } from "../src/services/dictionary.js";
import { publicFeed, utcWeek } from "../src/services/home.js";

// T10: the anonymous Home feed (design doc amendment D9/D14): 10 most-logged foods this week, 5 top
// detected allergens, newest 6 opted-in profiles; rebuilt at most every 5 minutes.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function account(username: string, opts: { publicLogs?: boolean; curator?: boolean } = {}) {
  await request(app)
    .post("/api/auth/register")
    .send({
      username,
      email: `${username}@example.com`,
      password: "correct horse battery",
      timezone: "UTC",
    })
    .expect(201);
  const user = (await User.findOne({ username }))!;
  if (opts.publicLogs)
    await MemberProfile.updateOne({ userId: user._id }, { $set: { publicLogs: true } });
  if (opts.curator) {
    await User.updateOne({ _id: user._id }, { $set: { roles: ["member", "curator"] } });
    await CuratorProfile.create({ userId: user._id, publicListing: true });
  }
  return user;
}

describe("GET /api/home/public", () => {
  // Value: protects=an empty database answers a valid empty feed, publicly; fails_when=the route needs a
  //   session or throws on no data; why_new=new route; seam=none; no_claim=web empty-state copy
  it("answers an empty feed with no data, without a session", async () => {
    const body = PublicHomeResponse.parse(
      (await request(app).get("/api/home/public").expect(200)).body,
    );
    expect(body).toMatchObject({
      foods: [],
      allergens: [],
      profiles: [],
      week: { from: "2026-11-10", to: "2026-11-16" },
    });
  });

  // Value: protects=counts cover this UTC week only, top lists are ordered and capped, and only active
  //   opted-in accounts appear with the right badges; fails_when=old logs count, private members leak,
  //   or suspended accounts show; why_new=new feed; seam=none; no_claim=real traffic volumes
  it("counts this week's foods and allergens and lists only opted-in active profiles", async () => {
    await loadDictionary();
    const peanut = (await Allergen.findOne({ key: "peanuts" }).lean())!;
    await Food.create([
      { fdcId: 1, description: "PEANUT BAR", dataType: "Branded", fetchedAt: new Date() },
      { fdcId: 2, description: "APPLE", dataType: "Foundation", fetchedAt: new Date() },
    ]);
    await FoodAllergen.create({
      fdcId: 1,
      allergenId: peanut._id,
      matchKind: "ingredient",
      matchedSynonym: "peanuts",
      matchedAt: new Date(),
    });
    const mia = await account("mia", { publicLogs: true });
    await account("lee"); // private
    const cleo = await account("cleo", { curator: true });
    const sam = await account("sam", { publicLogs: true });
    await User.updateOne({ _id: sam._id }, { $set: { status: "suspended" } });
    const log = (fdcId: number, date: string) =>
      LogEntry.create({
        userId: mia._id,
        date,
        meal: "lunch",
        fdcId,
        grams: 50,
        source: "search",
        confidence: 1,
      });
    await log(1, "2026-11-16");
    await log(1, "2026-11-12");
    await log(2, "2026-11-10");
    await log(2, "2026-11-09"); // last week: not counted
    for (let id = 3; id <= 14; id++) await log(id, "2026-11-15");

    const body = await publicFeed();
    expect(body.foods).toHaveLength(10);
    expect(body.foods[0]).toEqual({ fdcId: 1, description: "PEANUT BAR", count: 2 });
    expect(body.foods.find((f) => f.fdcId === 2)?.count).toBe(1);
    expect(body.foods.some((f) => f.description === null)).toBe(true); // uncached foods keep their id
    expect(body.allergens).toEqual([{ key: "peanuts", displayName: peanut.displayName, count: 2 }]);
    expect(body.profiles.map((p) => [p.username, p.badges])).toEqual([
      ["cleo", ["curator"]],
      ["mia", ["member"]],
    ]);
    expect(JSON.stringify(body.foods)).not.toContain("mia");
    expect(cleo).toBeTruthy();
  });

  // Value: protects=the feed is rebuilt at most every 5 minutes and concurrent stale requests rebuild
  //   once (D14); fails_when=every request aggregates or two requests rebuild; why_new=new cache;
  //   seam=none; no_claim=clock skew between instances
  it("serves the snapshot for 5 minutes and rebuilds once when stale", async () => {
    const spy = vi.spyOn(LogEntry, "aggregate");
    await publicFeed();
    await publicFeed(new Date("2026-11-16T12:04:00Z"));
    expect(spy).toHaveBeenCalledTimes(1);
    const later = new Date("2026-11-16T12:06:00Z");
    await Promise.all([publicFeed(later), publicFeed(later), publicFeed(later)]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect((await PublicFeedSnapshot.findById("public-home").lean())?.builtAt.toISOString()).toBe(
      later.toISOString(),
    );
  });

  it("lists the 7 UTC dates ending today", () => {
    expect(utcWeek(new Date("2026-12-02T23:59:00Z"))).toEqual([
      "2026-11-26",
      "2026-11-27",
      "2026-11-28",
      "2026-11-29",
      "2026-11-30",
      "2026-12-01",
      "2026-12-02",
    ]);
  });
});
