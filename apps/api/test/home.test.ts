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
import { deleteAccount } from "../src/services/account.js";
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
    // Extended by /ship test coverage audit (T10).
    // Value: protects=a curator who has not opted into the listing stays off Home; fails_when=the
    //   publicListing filter on CuratorProfile is dropped; why_new=every other curator fixture is
    //   listed; seam=none; no_claim=none beyond protects
    const ivy = await account("ivy");
    await User.updateOne({ _id: ivy._id }, { $set: { roles: ["member", "curator"] } });
    await CuratorProfile.create({ userId: ivy._id, publicListing: false });
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

  // Value: protects=a rebuild that fails after winning the claim serves the stale copy and leaves the
  //   snapshot stale, so the next request rebuilds (review p1); fails_when=builtAt stays moved forward
  //   and the old feed passes as fresh, or the claimant answers 500; why_new=review fix; seam=none;
  //   no_claim=a function killed mid-build
  it("serves the stale copy and retries on the next request when a claimed rebuild fails", async () => {
    const first = await publicFeed();
    const spy = vi.spyOn(LogEntry, "aggregate").mockRejectedValueOnce(new Error("timeout"));
    expect(await publicFeed(new Date("2026-11-16T12:06:00Z"))).toEqual(first);
    const snap = await PublicFeedSnapshot.findById("public-home").lean();
    expect(snap?.builtAt.toISOString()).toBe(first.builtAt);
    const again = await publicFeed(new Date("2026-11-16T12:07:00Z"));
    expect(again.builtAt).toBe("2026-11-16T12:07:00.000Z");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  // Value: protects=a slow rebuild whose claim was taken over never replaces the newer feed (review p1);
  //   fails_when=the final write is unconditional; why_new=review fix; seam=none; no_claim=none
  it("does not let a slow rebuild overwrite a newer one", async () => {
    await publicFeed();
    const newer = new Date("2026-11-16T12:20:00Z");
    const real = LogEntry.aggregate.bind(LogEntry);
    vi.spyOn(LogEntry, "aggregate").mockImplementationOnce(((...args: unknown[]) => {
      // While this rebuild runs, a later request claims and finishes its own.
      return PublicFeedSnapshot.updateOne(
        { _id: "public-home" },
        { $set: { builtAt: newer, "payload.builtAt": newer.toISOString() } },
      ).then(() => real(...(args as Parameters<typeof real>)));
    }) as never);
    await publicFeed(new Date("2026-11-16T12:06:00Z"));
    const snap = await PublicFeedSnapshot.findById("public-home").lean();
    expect(snap?.builtAt.toISOString()).toBe(newer.toISOString());
    expect((snap?.payload as { builtAt: string }).builtAt).toBe(newer.toISOString());
  });

  // Value: protects=a snapshot stored by a deploy with another feed shape is rebuilt, not a 500 on
  //   every request (review p1); fails_when=the stored payload is served unchecked; why_new=review fix;
  //   seam=none; no_claim=none
  it("rebuilds a fresh snapshot whose payload does not match the feed shape", async () => {
    await PublicFeedSnapshot.create({
      _id: "public-home",
      builtAt: new Date(),
      payload: { old: 1 },
    });
    const body = PublicHomeResponse.parse(
      (await request(app).get("/api/home/public").expect(200)).body,
    );
    expect(body.foods).toEqual([]);
  });

  // Value: protects=a deleted, suspended or opted-out account, or an ex-curator, leaves the anonymous
  //   Home at once even while the 5-minute snapshot still lists it, including a snapshot built before
  //   the change (review p2, privacy); fails_when=the stored profiles are served unchecked;
  //   why_new=review fix; seam=none; no_claim=none
  it("drops a deleted, suspended, opted-out or demoted account from a fresh snapshot at once", async () => {
    const mia = await account("mia", { publicLogs: true });
    const sam = await account("sam", { publicLogs: true });
    const lee = await account("lee", { publicLogs: true });
    const cleo = await account("cleo", { curator: true });
    const ann = await account("ann", { publicLogs: true });
    expect((await publicFeed()).profiles.map((p) => p.username).sort()).toEqual([
      "ann",
      "cleo",
      "lee",
      "mia",
      "sam",
    ]);
    const spy = vi.spyOn(LogEntry, "aggregate");
    await deleteAccount(mia._id);
    await User.updateOne({ _id: sam._id }, { $set: { status: "suspended" } });
    await MemberProfile.updateOne({ userId: lee._id }, { $set: { publicLogs: false } });
    await User.updateOne({ _id: cleo._id }, { $set: { roles: ["member"] } });
    const after = await publicFeed(new Date("2026-11-16T12:01:00Z"));
    expect(spy).not.toHaveBeenCalled(); // served from the snapshot, still within 5 minutes
    expect(after.profiles.map((p) => p.username)).toEqual(["ann"]);
    expect(ann).toBeTruthy();
  });

  // Generated by /ship test coverage audit (T10).
  // Value: protects=allergen counts sum every log this week, not only the top-10 foods, exclude dates
  //   after today, and keep the top 5 by count then key; fails_when=allergens read from the top-10
  //   slice, the week's upper bound or the 5 cap is dropped, or the key tie-break flips;
  //   why_new=the feed test has one allergen and one food; seam=none; no_claim=seed dictionary contents
  it("ranks allergens over every food logged this week, capped at 5", async () => {
    await loadDictionary();
    const keys = (await Allergen.find({}, { key: 1 }).lean())
      .map((a) => a.key)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 6);
    const ids = new Map(
      (await Allergen.find({ key: { $in: keys } }).lean()).map((a) => [a.key, a._id]),
    );
    const tag = (fdcId: number, key: string) =>
      FoodAllergen.create({
        fdcId,
        allergenId: ids.get(key),
        matchKind: "ingredient",
        matchedSynonym: key,
        matchedAt: new Date(),
      });
    for (const k of keys.slice(0, 4)) await tag(1, k);
    for (const k of keys.slice(4)) await tag(11, k);
    const mia = await account("mia", { publicLogs: true });
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
    for (let id = 1; id <= 10; id++) {
      await log(id, "2026-11-14");
      await log(id, "2026-11-15");
    }
    await log(11, "2026-11-16"); // food 11 ranks 11th: outside the top 10 foods
    await log(11, "2026-11-17"); // tomorrow in UTC: not counted

    const body = await publicFeed();
    expect(body.foods.map((f) => f.fdcId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(body.allergens.map((a) => [a.key, a.count])).toEqual([
      [keys[0], 2],
      [keys[1], 2],
      [keys[2], 2],
      [keys[3], 2],
      [keys[4], 1],
    ]);
  });

  // Generated by /ship test coverage audit (T10).
  // Value: protects=profiles are the newest opted-in active accounts, newest first, with a curator
  //   badge only while the role is held and no account pending deletion; fails_when=the deletionPending
  //   filter, the role check, the newest-first sort or the 6 cap is lost; why_new=the feed test covers
  //   private and suspended accounts only; seam=none; no_claim=more than one page of profiles
  it("lists the newest 6 opted-in profiles, dropping pending deletions and ex-curators' badge", async () => {
    let clock = Date.parse("2026-11-01T00:00:00Z");
    const next = async (username: string, opts?: { publicLogs?: boolean; curator?: boolean }) => {
      clock += 60_000;
      vi.setSystemTime(new Date(clock));
      return account(username, opts);
    };
    await next("oldest", { publicLogs: true }); // seventh newest eligible: cut by the cap
    for (const name of ["ann", "bob", "cat", "dan"]) await next(name, { publicLogs: true });
    const both = await next("both", { publicLogs: true, curator: true });
    const exCurator = await next("excur", { publicLogs: true, curator: true });
    await User.updateOne({ _id: exCurator._id }, { $set: { roles: ["member"] } });
    const leaving = await next("leaving", { publicLogs: true });
    await User.updateOne({ _id: leaving._id }, { $set: { deletionPending: true } });
    vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));

    const body = await publicFeed();
    expect(both).toBeTruthy();
    expect(body.profiles.map((p) => [p.username, p.badges])).toEqual([
      ["excur", ["member"]],
      ["both", ["member", "curator"]],
      ["dan", ["member"]],
      ["cat", ["member"]],
      ["bob", ["member"]],
      ["ann", ["member"]],
    ]);
  });

  // Value: protects=the feed lists the newest 6 accounts that still qualify; fails_when=badge-less
  //   accounts (an ex-curator whose listing flag stayed on) take a slot before filtering; why_new=bug
  //   found by the T10 coverage audit (5 shown instead of 6); seam=none; no_claim=none
  it("keeps six profile slots when a newer ex-curator no longer qualifies", async () => {
    for (const name of ["ana", "ben", "cai", "dee", "eli", "fay"]) {
      await account(name, { publicLogs: true });
      vi.setSystemTime(new Date(Date.now() + 1000));
    }
    const exCurator = await account("gus", { curator: true });
    await User.updateOne({ _id: exCurator._id }, { $set: { roles: ["member"] } });
    const body = await publicFeed();
    expect(body.profiles.map((p) => p.username)).toEqual([
      "fay",
      "eli",
      "dee",
      "cai",
      "ben",
      "ana",
    ]);
  });

  // Generated by /ship test coverage audit (T10).
  // Value: protects=a first build that loses the snapshot insert race still answers its feed, while
  //   other write errors surface; fails_when=the 11000 catch is removed or swallows every error;
  //   why_new=no test reaches the upsert catch; seam=none; no_claim=a real concurrent insert race
  //   (the model's updateOne is stubbed to reject)
  it("answers its own feed when another first build wins the snapshot insert", async () => {
    vi.spyOn(PublicFeedSnapshot, "updateOne").mockRejectedValueOnce(
      Object.assign(new Error("E11000 duplicate key"), { code: 11000 }),
    );
    const body = await publicFeed();
    expect(body.week).toEqual({ from: "2026-11-10", to: "2026-11-16" });

    await PublicFeedSnapshot.deleteMany({});
    vi.spyOn(PublicFeedSnapshot, "updateOne").mockRejectedValueOnce(
      Object.assign(new Error("write failed"), { code: 91 }),
    );
    await expect(publicFeed()).rejects.toThrow("write failed");
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
