import { Types } from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import app from "../src/app.js";
import {
  Allergen,
  CuratorProfile,
  Food,
  FoodAllergen,
  User,
  UserAllergen,
} from "../src/models/index.js";
import {
  createAllergen,
  deleteAllergen,
  loadDictionary,
  matchAndStore,
  rematchAllergen,
  startRematch,
} from "../src/services/dictionary.js";

afterEach(() => {
  vi.restoreAllMocks();
});
// T5: re-match one allergen over the cached foods in cursor batches (D6, S4, R3-4), and the allergen
// DELETE cascade (R3-3).

/** Cached foods 1..n; every third one contains peanuts. */
async function cacheFoods(n: number) {
  await Food.insertMany(
    Array.from({ length: n }, (_, i) => ({
      fdcId: i + 1,
      description: `FOOD ${i + 1}`,
      dataType: "Branded",
      ingredientsText: (i + 1) % 3 === 0 ? "SUGAR, PEANUTS, SALT" : "SUGAR, SALT",
      fetchedAt: new Date(),
    })),
  );
}

async function peanutId() {
  await loadDictionary(); // seeds the dictionary
  const doc = await Allergen.findOne({ key: "peanuts" }).lean();
  return doc!._id;
}

const peanutRows = async (id: Types.ObjectId) =>
  (await FoodAllergen.find({ allergenId: id }).sort({ fdcId: 1 }).lean()).map((r) => r.fdcId);

describe("rematchAllergen", () => {
  it("walks every cached food in fdcId batches and leaves the cursor null when done", async () => {
    await cacheFoods(10);
    const id = await peanutId();
    await startRematch(id);
    expect((await Allergen.findById(id).lean())?.rematchCursor).toBe(0);

    const res = await rematchAllergen(id, { batchSize: 4 });
    expect(res).toEqual({ done: true, processed: 10, remaining: 0 });
    expect(await peanutRows(id)).toEqual([3, 6, 9]);
    expect((await Allergen.findById(id).lean())?.rematchCursor).toBeNull();
  });

  it("resumes from the cursor after the time budget runs out, without skipping or repeating a food", async () => {
    await cacheFoods(10);
    const id = await peanutId();
    await startRematch(id);

    // A zero budget stops after the first batch: foods 1-4 done, the cursor is the next fdcId to do (5).
    const first = await rematchAllergen(id, { batchSize: 4, budgetMs: 0 });
    expect(first).toEqual({ done: false, processed: 4, remaining: 6 });
    expect((await Allergen.findById(id).lean())?.rematchCursor).toBe(5);
    expect(await peanutRows(id)).toEqual([3]);

    const bulk = vi.spyOn(FoodAllergen, "bulkWrite");
    const rest = await rematchAllergen(id, { batchSize: 4 });
    expect(rest).toEqual({ done: true, processed: 6, remaining: 0 });
    // Resumed at fdcId 5: the first batch it wrote covered 5..8, never food 4 again.
    const firstFilter = (bulk.mock.calls[0]![0] as [{ deleteMany: { filter: unknown } }])[0];
    expect(firstFilter.deleteMany.filter).toMatchObject({ fdcId: { $in: [5, 6, 7, 8] } });
    expect(await peanutRows(id)).toEqual([3, 6, 9]);
  });

  it("replaces the allergen's stale rows and drops the ones that no longer match", async () => {
    await cacheFoods(6);
    const id = await peanutId();
    await rematchAllergen(id); // cursor null: nothing to do
    expect(await peanutRows(id)).toEqual([]);
    // A stale row from an older synonym list, and another allergen's row that must survive.
    const milk = (await Allergen.findOne({ key: "milk" }).lean())!._id;
    await FoodAllergen.insertMany([
      {
        fdcId: 1,
        allergenId: id,
        matchKind: "ingredient",
        matchedSynonym: "sugar",
        matchedAt: new Date(),
      },
      {
        fdcId: 2,
        allergenId: milk,
        matchKind: "ingredient",
        matchedSynonym: "milk",
        matchedAt: new Date(),
      },
    ]);
    await startRematch(id);
    expect(await rematchAllergen(id)).toMatchObject({ done: true, processed: 6 });
    expect(await peanutRows(id)).toEqual([3, 6]);
    expect(await FoodAllergen.countDocuments({ allergenId: milk })).toBe(1);
  });

  it("starts over when an edit restarts the re-match part way, instead of finishing on the old cursor", async () => {
    await cacheFoods(8);
    const id = await peanutId();
    await startRematch(id);
    // The edit lands while the first batch is being written, when the cursor is still 0: only the run
    // counter shows the restart.
    const real = FoodAllergen.bulkWrite.bind(FoodAllergen);
    let restarted = false;
    vi.spyOn(FoodAllergen, "bulkWrite").mockImplementation((async (
      ...args: Parameters<typeof real>
    ) => {
      const out = await real(...args);
      if (!restarted) {
        restarted = true;
        await startRematch(id);
      }
      return out;
    }) as typeof FoodAllergen.bulkWrite);
    const res = await rematchAllergen(id, { batchSize: 4 });
    expect(res.done).toBe(true);
    expect(res.processed).toBe(12); // 4 before the restart, then all 8 again
    expect((await Allergen.findById(id).lean())?.rematchCursor).toBeNull();
    expect(await peanutRows(id)).toEqual([3, 6]);
  });

  // Generated by /ship coverage audit (T5).
  // Value: protects=a duplicate-key batch write (concurrent re-match) is retried, any other write error
  // fails without moving the cursor; fails_when=the 11000 catch is removed, widened to every error, or
  // moves on past the batch; why_new=no test drives the bulkWrite catch; seam=none; no_claim=a real
  // concurrent re-match (the duplicate and network errors are injected into bulkWrite)
  it("retries a batch that hit a concurrent re-match's duplicate key, and fails on any other write error", async () => {
    await cacheFoods(6);
    const id = await peanutId();
    await startRematch(id);
    const bulk = vi.spyOn(FoodAllergen, "bulkWrite");
    try {
      bulk.mockRejectedValueOnce(Object.assign(new Error("E11000 duplicate key"), { code: 11000 }));
      expect(await rematchAllergen(id, { batchSize: 4 })).toEqual({
        done: true,
        processed: 6,
        remaining: 0,
      });
      expect(await peanutRows(id)).toEqual([3, 6]);

      await startRematch(id);
      bulk.mockRejectedValueOnce(new Error("network blip"));
      await expect(rematchAllergen(id, { batchSize: 4 })).rejects.toThrow("network blip");
      expect((await Allergen.findById(id).lean())?.rematchCursor).toBe(0);
    } finally {
      bulk.mockRestore();
    }
  });

  it("drops the rows it wrote when the allergen is deleted while the pass runs", async () => {
    await cacheFoods(8);
    const id = await peanutId();
    await startRematch(id);
    const real = FoodAllergen.bulkWrite.bind(FoodAllergen);
    vi.spyOn(FoodAllergen, "bulkWrite").mockImplementationOnce((async (
      ...args: Parameters<typeof real>
    ) => {
      const out = await real(...args);
      await Allergen.deleteOne({ _id: id }); // the Curator's delete (and its sweeps) landed meanwhile
      return out;
    }) as typeof FoodAllergen.bulkWrite);
    await expect(rematchAllergen(id, { batchSize: 4 })).rejects.toMatchObject({ status: 404 });
    expect(await FoodAllergen.countDocuments({ allergenId: id })).toBe(0);
  });

  it("answers 404 for an allergen that does not exist", async () => {
    await expect(startRematch(new User()._id)).rejects.toMatchObject({ status: 404 });
    await expect(rematchAllergen(new User()._id)).rejects.toMatchObject({ status: 404 });
  });
});

async function login(username: string, roles: string[] = ["member"]) {
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
  const user = await User.findOneAndUpdate({ username }, { $set: { roles } }, { new: true });
  if (roles.includes("curator")) await CuratorProfile.create({ userId: user!._id });
  return { agent, user: user! };
}

describe("re-match racing a first match of a food", () => {
  // Value: protects=a food matched by a concurrent first read keeps its allergen row through a re-match
  //   batch whose fdcId range covers it; fails_when=the batch deletes over its whole [cursor, last] range
  //   again; why_new=T21 runs the re-match from live routes, so a food can be cached mid-batch; seam=none;
  //   no_claim=timing of real concurrent requests (the interleaving is injected)
  it("keeps the row of a food cached and matched after the batch read the foods", async () => {
    await cacheFoods(6);
    await Food.deleteOne({ fdcId: 3 }); // not cached yet when the batch reads the foods
    const id = await peanutId();
    await startRematch(id);
    const original = FoodAllergen.bulkWrite.bind(FoodAllergen);
    let injected = false;
    vi.spyOn(FoodAllergen, "bulkWrite").mockImplementation((async (ops: never, opts: never) => {
      if (!injected) {
        injected = true;
        // Another request caches food 3 and matches it while this batch is between its read and its write.
        await Food.create({
          fdcId: 3,
          description: "FOOD 3",
          dataType: "Branded",
          ingredientsText: "SUGAR, PEANUTS, SALT",
          fetchedAt: new Date(),
          allergensMatchedAt: new Date(),
        });
        await FoodAllergen.create({
          fdcId: 3,
          allergenId: id,
          matchKind: "ingredient",
          matchedSynonym: "peanuts",
          matchedAt: new Date(),
        });
      }
      return original(ops, opts);
    }) as never);
    const res = await rematchAllergen(id, { batchSize: 10 });
    expect(res.done).toBe(true);
    expect(await peanutRows(id)).toEqual([3, 6]);
  });

  // Value: protects=a food matched against the dictionary as it was before a Curator edit, but written
  //   after that edit's re-match passed it, does not keep the old matches; fails_when=matchAndStore stops
  //   re-checking the dictionary version after its write; why_new=same T21 race, mirror case; seam=none;
  //   no_claim=timing of real concurrent requests (the interleaving is injected)
  it("matches again when a Curator edit and its re-match land between the dictionary read and the write", async () => {
    const food = {
      fdcId: 42,
      description: "CAROB BAR",
      dataType: "Branded",
      ingredientsText: "CAROB, OATS, SALT",
      fetchedAt: new Date(),
    };
    await Food.create(food);
    await loadDictionary();
    const curator = new Types.ObjectId();
    const original = FoodAllergen.bulkWrite.bind(FoodAllergen);
    let injected = false;
    vi.spyOn(FoodAllergen, "bulkWrite").mockImplementation((async (ops: never, opts: never) => {
      if (!injected) {
        injected = true;
        // A Curator adds carob; its re-match writes the carob row for food 42 before this write lands.
        await createAllergen(
          {
            key: "carob",
            displayName: "Carob",
            tier: "allergy",
            synonyms: ["carob"],
            descriptionKeywords: [],
            excludePhrases: [],
          },
          curator,
        );
      }
      return original(ops, opts);
    }) as never);
    const matches = await matchAndStore(food);
    expect(matches.map((m) => m.key)).toContain("carob");
    const carob = (await Allergen.findOne({ key: "carob" }).lean())!;
    expect(await FoodAllergen.countDocuments({ fdcId: 42, allergenId: carob._id })).toBe(1);
    expect((await Food.findOne({ fdcId: 42 }).lean())?.allergensMatchedAt).toBeInstanceOf(Date);
  });

  it("leaves the food unstamped when the dictionary keeps changing, so the next read matches again", async () => {
    const food = {
      fdcId: 43,
      description: "OAT BAR",
      dataType: "Branded",
      ingredientsText: "OATS, SALT",
      fetchedAt: new Date(),
    };
    await Food.create(food);
    await loadDictionary();
    const id = await peanutId();
    const original = FoodAllergen.bulkWrite.bind(FoodAllergen);
    vi.spyOn(FoodAllergen, "bulkWrite").mockImplementation((async (ops: never, opts: never) => {
      await Allergen.updateOne({ _id: id }, { $inc: { rematchRun: 1 } }); // an edit on every attempt
      return original(ops, opts);
    }) as never);
    await matchAndStore(food);
    expect((await Food.findOne({ fdcId: 43 }).lean())?.allergensMatchedAt ?? null).toBeNull();
  });

  // Generated by /ship coverage audit (rematch race fix).
  // Value: protects=a food matched against a dictionary that still had an entry, written after a Curator
  //   deleted it, keeps no row for the deleted entry; fails_when=the dictionary version stops counting
  //   entry ids (only rematchRun), so a delete goes unnoticed; why_new=the add and edit cases above
  //   both change rematchRun, only a delete shrinks the id set; seam=none; no_claim=timing of real
  //   concurrent requests (the interleaving is injected)
  it("drops the row of an entry a Curator deleted between the dictionary read and the write", async () => {
    const food = {
      fdcId: 44,
      description: "PEANUT BAR",
      dataType: "Branded",
      ingredientsText: "PEANUTS, SUGAR",
      fetchedAt: new Date(),
    };
    await Food.create(food);
    const id = await peanutId();
    const original = FoodAllergen.bulkWrite.bind(FoodAllergen);
    let injected = false;
    vi.spyOn(FoodAllergen, "bulkWrite").mockImplementation((async (ops: never, opts: never) => {
      if (!injected) {
        injected = true;
        // A Curator deletes peanuts, cascade and trailing sweep included, before this write lands.
        await deleteAllergen(String(id));
      }
      return original(ops, opts);
    }) as never);
    const matches = await matchAndStore(food);
    expect(matches.map((m) => m.key)).not.toContain("peanuts");
    expect(await FoodAllergen.countDocuments({ allergenId: id })).toBe(0);
    expect((await Food.findOne({ fdcId: 44 }).lean())?.allergensMatchedAt).toBeInstanceOf(Date);
  });
});

describe("re-match batch racing a food refresh or a newer re-match", () => {
  // Value: protects=a re-match batch that read a food's old USDA copy does not leave that copy's match
  //   after the refreshed copy was matched; fails_when=the batch stops re-checking the foods' fetchedAt
  //   after its write; why_new=follow-up to #36 (pre-existing race); seam=none; no_claim=timing of real
  //   concurrent requests (the interleaving is injected)
  it("rewrites a food refreshed from USDA between the batch read and the batch write", async () => {
    await cacheFoods(6);
    const id = await peanutId();
    await startRematch(id);
    const original = FoodAllergen.bulkWrite.bind(FoodAllergen);
    let injected = false;
    vi.spyOn(FoodAllergen, "bulkWrite").mockImplementation((async (ops: never, opts: never) => {
      if (!injected) {
        injected = true;
        // USDA's new copy of food 3 has no peanuts; the refresh stores and matches it before this write.
        const fresh = {
          fdcId: 3,
          description: "FOOD 3",
          ingredientsText: "SUGAR, SALT",
          fetchedAt: new Date(Date.now() + 60_000),
          allergensMatchedAt: null,
        };
        await Food.updateOne({ fdcId: 3 }, { $set: fresh });
        await matchAndStore(fresh);
      }
      return original(ops, opts);
    }) as never);
    const res = await rematchAllergen(id, { batchSize: 10 });
    expect(res.done).toBe(true);
    expect(await peanutRows(id)).toEqual([6]);
    expect((await Food.findOne({ fdcId: 3 }).lean())?.allergensMatchedAt).toBeInstanceOf(Date);
  });

  // Value: protects=a re-match pass for an older edit, whose batch write lands after a newer edit's pass
  //   already rewrote those foods, does not leave the older entry's matches; fails_when=the batch stops
  //   re-checking rematchRun after its write; why_new=follow-up to #36 (pre-existing race); seam=none;
  //   no_claim=timing of real concurrent requests (the interleaving is injected)
  it("rewrites a batch with the newer entry when a newer edit's re-match finished before this batch's write", async () => {
    await cacheFoods(8);
    const id = await peanutId();
    await startRematch(id);
    const original = FoodAllergen.bulkWrite.bind(FoodAllergen);
    let injected = false;
    vi.spyOn(FoodAllergen, "bulkWrite").mockImplementation((async (ops: never, opts: never) => {
      if (!injected) {
        injected = true;
        // A Curator edits the entry to match "salt" (every food), and its re-match runs to the end.
        await Allergen.updateOne(
          { _id: id },
          { $set: { synonyms: ["salt"], rematchCursor: 0 }, $inc: { rematchRun: 1 } },
        );
        expect((await rematchAllergen(id, { batchSize: 4 })).done).toBe(true);
      }
      return original(ops, opts);
    }) as never);
    const res = await rematchAllergen(id, { batchSize: 4 });
    expect(res.done).toBe(true);
    expect(await peanutRows(id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("leaves the batch's foods unstamped when the entry keeps changing, so their next read matches again", async () => {
    await cacheFoods(4);
    await Food.updateMany({}, { $set: { allergensMatchedAt: new Date() } });
    const id = await peanutId();
    await startRematch(id);
    const original = FoodAllergen.bulkWrite.bind(FoodAllergen);
    let writes = 0;
    vi.spyOn(FoodAllergen, "bulkWrite").mockImplementation((async (ops: never, opts: never) => {
      const out = await original(ops, opts);
      // An edit after each of the first two writes (no cursor reset, so the pass then ends).
      if (++writes <= 2) await Allergen.updateOne({ _id: id }, { $inc: { rematchRun: 1 } });
      return out;
    }) as never);
    expect((await rematchAllergen(id, { batchSize: 10 })).done).toBe(true);
    const stamps = (await Food.find().lean()).map((f) => f.allergensMatchedAt ?? null);
    expect(stamps).toEqual([null, null, null, null]);
  });
});

describe("re-match batch check after its write (#37 review notes)", () => {
  // Value: protects=a stored food without a Date fetchedAt does not stop an allergen's re-match for
  //   good; fails_when=the post-write check calls getTime() on a missing fetchedAt again; why_new=#37
  //   review note; seam=none; no_claim=how such a document got stored (inserted past the schema)
  // Extended by /ship coverage audit (#46).
  // Value: protects=a food with no fetchedAt counts as unmoved, so the re-match leaves its stamp;
  //   fails_when=a missing fetchedAt never equals itself and the food is unstamped on every re-match;
  //   why_new=this test asserted only done and rows; seam=none; no_claim=how such a document got stored
  it("finishes the re-match when a stored food has no fetchedAt", async () => {
    await cacheFoods(4);
    await Food.collection.insertOne({
      fdcId: 5,
      description: "FOOD 5",
      ingredientsText: "PEANUTS",
      allergensMatchedAt: new Date(),
    });
    const id = await peanutId();
    await startRematch(id);
    expect((await rematchAllergen(id, { batchSize: 10 })).done).toBe(true);
    expect(await peanutRows(id)).toEqual([3, 5]);
    expect((await Food.findOne({ fdcId: 5 }).lean())?.allergensMatchedAt).toBeInstanceOf(Date);
  });

  // Value: protects=when only a food's USDA copy keeps moving, only that food is left unstamped;
  //   fails_when=the fallback unstamps the whole batch again; why_new=#37 review note; seam=none;
  //   no_claim=timing of real concurrent refreshes (injected after each write)
  it("leaves only the food whose copy kept changing unstamped", async () => {
    await cacheFoods(4);
    await Food.updateMany({}, { $set: { allergensMatchedAt: new Date() } });
    const id = await peanutId();
    await startRematch(id);
    const original = FoodAllergen.bulkWrite.bind(FoodAllergen);
    let writes = 0;
    vi.spyOn(FoodAllergen, "bulkWrite").mockImplementation((async (ops: never, opts: never) => {
      const out = await original(ops, opts);
      // A USDA refresh of food 2 after each of the first two writes.
      if (++writes <= 2)
        await Food.updateOne(
          { fdcId: 2 },
          { $set: { fetchedAt: new Date(Date.now() + writes * 1000) } },
        );
      return out;
    }) as never);
    expect((await rematchAllergen(id, { batchSize: 10 })).done).toBe(true);
    const stamps = (await Food.find().sort({ fdcId: 1 }).lean()).map(
      (f) => f.allergensMatchedAt !== null,
    );
    expect(stamps).toEqual([true, false, true, true]);
  });

  // Generated by /ship coverage audit (#37 review notes).
  // Value: protects=when a newer edit and a food refresh both land before the last check, the whole
  //   batch is left unstamped, not only the refreshed food; fails_when=the fallback picks the moved
  //   foods whenever any moved, ignoring the run counter; why_new=the run-moved and copy-moved fallback
  //   tests each move one thing only; seam=none; no_claim=timing of real concurrent writers (injected)
  it("leaves the whole batch unstamped when an edit and a food refresh both land before the last check", async () => {
    await cacheFoods(4);
    await Food.updateMany({}, { $set: { allergensMatchedAt: new Date() } });
    const id = await peanutId();
    await startRematch(id);
    const original = FoodAllergen.bulkWrite.bind(FoodAllergen);
    let writes = 0;
    vi.spyOn(FoodAllergen, "bulkWrite").mockImplementation((async (ops: never, opts: never) => {
      const out = await original(ops, opts);
      writes++;
      // A refresh of food 2 after the first write; after the second, another refresh and an edit.
      if (writes <= 2)
        await Food.updateOne(
          { fdcId: 2 },
          { $set: { fetchedAt: new Date(Date.now() + writes * 1000) } },
        );
      if (writes === 2) await Allergen.updateOne({ _id: id }, { $inc: { rematchRun: 1 } });
      return out;
    }) as never);
    expect((await rematchAllergen(id, { batchSize: 10 })).done).toBe(true);
    const stamps = (await Food.find().sort({ fdcId: 1 }).lean()).map(
      (f) => f.allergensMatchedAt ?? null,
    );
    expect(stamps).toEqual([null, null, null, null]);
  });

  // Value: protects=a re-match whose batch keeps colliding with a concurrent writer stops at its time
  //   budget and reports done: false; fails_when=the duplicate-key retry skips the budget check again;
  //   why_new=#37 review note (pre-existing); seam=none; no_claim=a real concurrent writer (the
  //   duplicate key is injected)
  it("stops at its time budget when a batch keeps hitting a duplicate key", async () => {
    await cacheFoods(4);
    const id = await peanutId();
    await startRematch(id);
    const dup = () => Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    const bulk = vi
      .spyOn(FoodAllergen, "bulkWrite")
      .mockRejectedValueOnce(dup())
      .mockRejectedValueOnce(dup())
      .mockRejectedValueOnce(dup());
    expect(await rematchAllergen(id, { batchSize: 10, budgetMs: 0 })).toEqual({
      done: false,
      processed: 0,
      remaining: 4,
    });
    expect(bulk).toHaveBeenCalledTimes(1);
    expect((await Allergen.findById(id).lean())?.rematchCursor).toBe(0);
  });
});

describe("re-match batch check after its write (#46 review notes)", () => {
  // Value: protects=a refresh between two malformed (non-Date) fetchedAt values still counts as a new
  //   copy, so the batch rewrites from it; fails_when=every non-Date fetchedAt compares equal again;
  //   why_new=#46 review note; seam=none; no_claim=how such documents got stored (written past the schema)
  // Extended by /ship coverage audit (#46).
  // Value: protects=an unchanged malformed copy compares equal, so after the rewrite the food keeps its
  //   stamp; fails_when=a malformed fetchedAt never equals itself (e.g. NaN key) and the food is left
  //   unstamped; why_new=no test asserts a stable non-Date copy keeps its stamp; seam=none;
  //   no_claim=how such documents got stored (written past the schema)
  it("rewrites a food whose malformed fetchedAt changed between the batch read and its check", async () => {
    await cacheFoods(2);
    await Food.collection.insertOne({
      fdcId: 3,
      description: "FOOD 3",
      ingredientsText: "SUGAR, PEANUTS",
      fetchedAt: "copy-a",
      allergensMatchedAt: new Date(),
    });
    const id = await peanutId();
    await startRematch(id);
    const original = FoodAllergen.bulkWrite.bind(FoodAllergen);
    let injected = false;
    vi.spyOn(FoodAllergen, "bulkWrite").mockImplementation((async (ops: never, opts: never) => {
      const out = await original(ops, opts);
      if (!injected) {
        injected = true;
        // A new, still malformed copy of food 3 without peanuts lands after the first write.
        await Food.collection.updateOne(
          { fdcId: 3 },
          { $set: { ingredientsText: "SUGAR, SALT", fetchedAt: "copy-b" } },
        );
      }
      return out;
    }) as never);
    expect((await rematchAllergen(id, { batchSize: 10 })).done).toBe(true);
    expect(await peanutRows(id)).toEqual([]);
    expect((await Food.findOne({ fdcId: 3 }).lean())?.allergensMatchedAt).toBeInstanceOf(Date);
  });

  // Value: protects=a batch whose ordered write stops at a duplicate key part way (its later inserts
  //   never ran) leaves its foods unstamped, so no food stays stamped without this allergen's row;
  //   fails_when=the duplicate branch returns or moves on without unstamping; why_new=#46 follow-up
  //   review (the duplicate branch skipped the post-write check); seam=none; no_claim=a real collision
  //   (the partial write is injected: delete ran, inserts did not)
  it("leaves the batch's foods unstamped when its write stops part way at a duplicate key", async () => {
    await cacheFoods(6);
    const id = await peanutId();
    await startRematch(id);
    await rematchAllergen(id);
    await Food.updateMany({}, { $set: { allergensMatchedAt: new Date() } });
    expect(await peanutRows(id)).toEqual([3, 6]);
    await startRematch(id);
    vi.spyOn(FoodAllergen, "bulkWrite").mockImplementationOnce((async () => {
      // The ordered write's delete ran, then its first insert hit a row another writer had just added.
      await FoodAllergen.deleteMany({ allergenId: id, fdcId: { $in: [1, 2, 3, 4, 5, 6] } });
      throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    }) as never);
    expect((await rematchAllergen(id, { batchSize: 10, budgetMs: 0 })).done).toBe(false);
    const stamps = (await Food.find().sort({ fdcId: 1 }).lean()).map(
      (f) => f.allergensMatchedAt ?? null,
    );
    expect(stamps).toEqual([null, null, null, null, null, null]);
  });

  // Value: protects=a batch that hit a duplicate key leaves its foods unstamped even when it goes on to
  //   repeat, since another pass can move the cursor before the repeat; fails_when=the duplicate branch
  //   skips the unstamp when it expects to repeat; why_new=#46 follow-up review (pass 2); seam=none;
  //   no_claim=a real collision or a racing pass (the duplicate key is injected once)
  it("leaves the batch's foods unstamped after a duplicate key even when it repeats the batch", async () => {
    await cacheFoods(4);
    await Food.updateMany({}, { $set: { allergensMatchedAt: new Date() } });
    const id = await peanutId();
    await startRematch(id);
    vi.spyOn(FoodAllergen, "bulkWrite").mockRejectedValueOnce(
      Object.assign(new Error("E11000 duplicate key"), { code: 11000 }),
    );
    expect((await rematchAllergen(id, { batchSize: 10 })).done).toBe(true);
    expect(await peanutRows(id)).toEqual([3]);
    const stamps = (await Food.find().sort({ fdcId: 1 }).lean()).map(
      (f) => f.allergensMatchedAt ?? null,
    );
    expect(stamps).toEqual([null, null, null, null]);
  });

  // Value: protects=a batch that stops at its budget on a duplicate key, after its first write went
  //   stale, leaves the rows the surviving concurrent writer (a food's own match) wrote, and leaves
  //   the batch's foods unstamped since it did not repeat;
  //   fails_when=the early budget return starts deleting or rewriting rows, or matchAndStore stops
  //   rewriting a food's rows; why_new=#46 review note; seam=none; no_claim=a real collision (the
  //   duplicate key is injected after the concurrent match)
  it("leaves a concurrent food match's rows when the batch stops at its budget on a duplicate key", async () => {
    await cacheFoods(3);
    const id = await peanutId();
    await startRematch(id);
    const original = FoodAllergen.bulkWrite.bind(FoodAllergen);
    let calls = 0;
    let inner = false;
    vi.spyOn(FoodAllergen, "bulkWrite").mockImplementation((async (ops: never, opts: never) => {
      if (inner) return original(ops, opts);
      calls++;
      if (calls === 1) {
        const out = await original(ops, opts); // the batch's first write: food 3 has peanuts
        // USDA refreshes food 3 without peanuts and its own read matches the new copy.
        const fresh = {
          fdcId: 3,
          description: "FOOD 3",
          ingredientsText: "SUGAR, SALT",
          fetchedAt: new Date(Date.now() + 60_000),
          allergensMatchedAt: null,
        };
        await Food.updateOne({ fdcId: 3 }, { $set: fresh });
        inner = true;
        await matchAndStore(fresh);
        inner = false;
        return out;
      }
      throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 }); // the batch's rewrite
    }) as never);
    const res = await rematchAllergen(id, { batchSize: 10, budgetMs: 0 });
    expect(res.done).toBe(false);
    expect(await peanutRows(id)).toEqual([]);
    // The batch did not repeat, so it cannot vouch for its foods' rows: each is left for its next read.
    const stamps = (await Food.find().sort({ fdcId: 1 }).lean()).map(
      (f) => f.allergensMatchedAt ?? null,
    );
    expect(stamps).toEqual([null, null, null]);
  });
});

describe("DELETE /api/allergens/:id", () => {
  it("removes the entry with its FoodAllergen and UserAllergen rows, and counts the Curator's edit", async () => {
    await cacheFoods(6);
    const id = await peanutId();
    await startRematch(id);
    await rematchAllergen(id);
    const { agent: member } = await login("mia");
    await member
      .put("/api/users/me/allergens")
      .send({ allergens: [{ key: "peanuts" }, { key: "soy" }] })
      .expect(200);
    const { agent: cura, user } = await login("cura", ["member", "curator"]);

    await cura.delete(`/api/allergens/${id}`).expect(204);

    expect(await Allergen.exists({ _id: id })).toBeNull();
    expect(await FoodAllergen.countDocuments({ allergenId: id })).toBe(0);
    expect(await UserAllergen.countDocuments({ allergenId: id })).toBe(0);
    const left = await member.get("/api/users/me/allergens").expect(200);
    expect(left.body.allergens.map((a: { key: string }) => a.key)).toEqual(["soy"]);
    const profile = await CuratorProfile.findOne({ userId: user._id }).lean();
    expect(profile?.editsCount).toBe(1);
    expect(profile?.lastEditAt).toBeInstanceOf(Date);
    // A seed entry a Curator deleted stays deleted (T11 marker).
    await request(app).get("/api/allergens").expect(200);
    expect(await Allergen.exists({ key: "peanuts" })).toBeNull();
  });

  it("is 401 without a session, 403 for a member, 404 for an unknown or malformed id", async () => {
    const id = await peanutId();
    await request(app).delete(`/api/allergens/${id}`).expect(401);
    const { agent: member } = await login("mia");
    await member.delete(`/api/allergens/${id}`).expect(403);
    const { agent: cura } = await login("cura", ["member", "curator"]);
    await cura.delete(`/api/allergens/${new User()._id}`).expect(404);
    await cura.delete("/api/allergens/not-an-id").expect(404);
    expect(await Allergen.exists({ _id: id })).not.toBeNull();
    // Extended by /ship coverage audit (T5).
    // Value: protects=a refused delete counts no Curator edit; fails_when=the editsCount increment moves
    // before deleteAllergen or ignores its error; why_new=only the 204 path checked editsCount; seam=none;
    // no_claim=none beyond protects
    const curaUser = (await User.findOne({ username: "cura" }).lean())!;
    expect((await CuratorProfile.findOne({ userId: curaUser._id }).lean())?.editsCount ?? 0).toBe(
      0,
    );
  });

  // Generated by /ship coverage audit (T5).
  // Value: protects=a FoodAllergen row written by a concurrent match while the entry still existed is
  // gone after the delete; fails_when=the trailing FoodAllergen.deleteMany is dropped; why_new=other
  // tests have no row arriving mid-cascade; seam=none; no_claim=a real concurrent matchAndStore (the
  // row is inserted from a wrapped Allergen.deleteOne)
  it("removes a FoodAllergen row a concurrent match wrote while the entry still existed", async () => {
    const id = await peanutId();
    const { agent: cura } = await login("cura", ["member", "curator"]);
    const real = Allergen.deleteOne.bind(Allergen);
    const del = vi.spyOn(Allergen, "deleteOne").mockImplementationOnce(((
      ...args: Parameters<typeof real>
    ) =>
      FoodAllergen.create({
        fdcId: 42,
        allergenId: id,
        matchKind: "ingredient",
        matchedSynonym: "peanuts",
        matchedAt: new Date(),
      }).then(() => real(...args))) as unknown as typeof Allergen.deleteOne);
    try {
      await cura.delete(`/api/allergens/${id}`).expect(204);
    } finally {
      del.mockRestore();
    }
    expect(await Allergen.exists({ _id: id })).toBeNull();
    expect(await FoodAllergen.countDocuments({ allergenId: id })).toBe(0);
  });

  it("still sweeps rows left by a crash after the entry was deleted, answering 404", async () => {
    await cacheFoods(6);
    const id = await peanutId();
    await startRematch(id);
    await rematchAllergen(id);
    const { agent: cura } = await login("cura", ["member", "curator"]);
    await Allergen.deleteOne({ _id: id }); // the entry is gone ...
    await FoodAllergen.create({
      fdcId: 3,
      allergenId: id,
      matchKind: "ingredient",
      matchedSynonym: "peanuts",
      matchedAt: new Date(),
    }).catch(() => undefined);
    // ... but rows remain (a crash before the final sweep). A retry cleans them up.
    expect(await FoodAllergen.countDocuments({ allergenId: id })).toBeGreaterThan(0);
    await cura.delete(`/api/allergens/${id}`).expect(404);
    expect(await FoodAllergen.countDocuments({ allergenId: id })).toBe(0);
  });

  it("finishes on a retry after a crash part way", async () => {
    await cacheFoods(6);
    const id = await peanutId();
    await startRematch(id);
    await rematchAllergen(id);
    const { agent: cura } = await login("cura", ["member", "curator"]);
    vi.spyOn(UserAllergen, "deleteMany").mockRejectedValueOnce(new Error("network blip"));
    await cura.delete(`/api/allergens/${id}`).expect(500);
    expect(await Allergen.exists({ _id: id })).not.toBeNull();
    await cura.delete(`/api/allergens/${id}`).expect(204);
    expect(await FoodAllergen.countDocuments({ allergenId: id })).toBe(0);
    expect(await Allergen.exists({ _id: id })).toBeNull();
  });
});
