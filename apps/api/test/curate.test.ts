import type { Types } from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import app from "../src/app.js";
import { Allergen, CuratorProfile, Food, FoodAllergen, User } from "../src/models/index.js";
import { createAllergen, loadDictionary, updateAllergen } from "../src/services/dictionary.js";

afterEach(() => {
  vi.restoreAllMocks();
});
// T21: Curator dictionary writes (POST and PUT /api/allergens) with the re-match in the same request,
// and POST /api/curate/allergens/:id/rematch to continue one (design doc, Re-match on dictionary change).

const PASSWORD = "correct horse battery";

async function account(username: string, roles: string[] = ["member"]) {
  const agent = request.agent(app);
  await agent
    .post("/api/auth/register")
    .send({ username, email: `${username}@example.com`, password: PASSWORD, timezone: "UTC" })
    .expect(201);
  const user = (await User.findOne({ username }))!;
  if (roles.length > 1) {
    await User.updateOne({ _id: user._id }, { $set: { roles } });
    if (roles.includes("curator")) await CuratorProfile.create({ userId: user._id });
  }
  return { agent, user };
}

/** Cached foods 1..n; every third one lists sesame. */
async function cacheFoods(n: number) {
  await Food.insertMany(
    Array.from({ length: n }, (_, i) => ({
      fdcId: i + 1,
      description: `FOOD ${i + 1}`,
      dataType: "Branded",
      ingredientsText: (i + 1) % 3 === 0 ? "FLOUR, TAHINI, SALT" : "FLOUR, SALT",
      fetchedAt: new Date(),
    })),
  );
}

const tahini = {
  key: "tahini",
  displayName: "Tahini",
  tier: "allergy",
  synonyms: ["tahini"],
  descriptionKeywords: [],
  excludePhrases: [],
};

const rowsOf = async (allergenId: Types.ObjectId | string) =>
  (await FoodAllergen.find({ allergenId }).sort({ fdcId: 1 }).lean()).map((r) => r.fdcId);

/** Every Date.now() call jumps a minute, so the 60-second re-match budget runs out after one batch. */
const slowClock = () => {
  let t = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => (t += 61_000));
};

describe("POST /api/allergens", () => {
  // Value: protects=the T21 done-when guard (member and admin get 403 on a dictionary write); fails_when=
  //   POST loses requireRole("curator") or checks activeRole instead of roles; why_new=no write route
  //   existed; seam=none; no_claim=the UI hiding the form
  it("is 401 without a session and 403 for a member and for an admin", async () => {
    await request(app).post("/api/allergens").send(tahini).expect(401);
    const { agent: member } = await account("mia");
    await member.post("/api/allergens").send(tahini).expect(403);
    const { agent: admin } = await account("adam", ["member", "admin"]);
    await admin.post("/api/allergens").send(tahini).expect(403);
    expect(await Allergen.countDocuments({ key: "tahini" })).toBe(0);
  });

  it("creates a curator entry, matches every cached food in the same request and counts the edit", async () => {
    await cacheFoods(7);
    const { agent, user } = await account("cleo", ["member", "curator"]);
    const res = await agent.post("/api/allergens").send(tahini).expect(201);
    expect(res.body.allergen).toMatchObject({
      key: "tahini",
      source: "curator",
      rematchPending: false,
    });
    expect(res.body.rematch).toEqual({ done: true, processed: 7, remaining: 0 });
    const stored = await Allergen.findOne({ key: "tahini" }).lean();
    expect(String(stored?.updatedBy)).toBe(String(user._id));
    expect(await rowsOf(stored!._id)).toEqual([3, 6]);
    const profile = await CuratorProfile.findOne({ userId: user._id }).lean();
    expect(profile?.editsCount).toBe(1);
    expect(profile?.lastEditAt).toBeInstanceOf(Date);
    const list = await request(app).get("/api/allergens").expect(200);
    expect(list.body.allergens.find((a: { key: string }) => a.key === "tahini")).toBeTruthy();
  });

  it("answers 409 for a key that exists, seed keys included, and 400 for an invalid entry", async () => {
    const { agent } = await account("cleo", ["member", "curator"]);
    const dup = await agent
      .post("/api/allergens")
      .send({ ...tahini, key: "peanuts" })
      .expect(409);
    expect(dup.body).toMatchObject({ error: "conflict", details: { fields: ["key"] } });
    await agent
      .post("/api/allergens")
      .send({ ...tahini, key: "Not A Key" })
      .expect(400);
    await agent
      .post("/api/allergens")
      .send({ ...tahini, tier: "mild" })
      .expect(400);
    expect(await Allergen.countDocuments({ source: "curator" })).toBe(0);
  });

  it("answers 202 with the foods left when the re-match runs out of time, and the page continues it", async () => {
    await cacheFoods(501); // one more than a batch
    const { agent } = await account("cleo", ["member", "curator"]);
    slowClock();
    const res = await agent.post("/api/allergens").send(tahini).expect(202);
    vi.restoreAllMocks();
    expect(res.body.rematch).toEqual({ done: false, processed: 500, remaining: 1 });
    expect(res.body.allergen.rematchPending).toBe(true);
    const id = res.body.allergen.id as string;

    const next = await agent.post(`/api/curate/allergens/${id}/rematch`).expect(200);
    expect(next.body).toEqual({ done: true, processed: 1, remaining: 0 });
    expect((await rowsOf(id)).length).toBe(167);
    const list = await request(app).get("/api/allergens").expect(200);
    const entry = list.body.allergens.find((a: { id: string }) => a.id === id);
    expect(entry.rematchPending).toBe(false);
    // Continuing a finished re-match is a no-op, and does not count as an edit.
    await agent.post(`/api/curate/allergens/${id}/rematch`).expect(200);
    const profile = await CuratorProfile.findOne({}).lean();
    expect(profile?.editsCount).toBe(1);
  });
});

describe("PUT /api/allergens/:id", () => {
  it("replaces the fields, re-matches the foods with the new synonyms and marks the entry curator-written", async () => {
    await cacheFoods(6);
    await loadDictionary();
    const sesame = (await Allergen.findOne({ key: "sesame" }).lean())!;
    expect(sesame.source).toBe("seed");
    const { agent, user } = await account("cleo", ["member", "curator"]);
    const res = await agent
      .put(`/api/allergens/${sesame._id}`)
      .send({
        displayName: "Sesame seeds",
        tier: "allergy",
        synonyms: ["tahini"],
        descriptionKeywords: [],
        excludePhrases: [],
      })
      .expect(200);
    expect(res.body.allergen).toMatchObject({
      key: "sesame",
      displayName: "Sesame seeds",
      source: "curator",
      synonyms: ["tahini"],
    });
    expect(res.body.rematch).toEqual({ done: true, processed: 6, remaining: 0 });
    expect(await rowsOf(sesame._id)).toEqual([3, 6]);
    const stored = (await Allergen.findById(sesame._id).lean())!;
    expect(String(stored.updatedBy)).toBe(String(user._id));
    expect(stored.rematchRun).toBe((sesame.rematchRun ?? 0) + 1);
    expect((await CuratorProfile.findOne({ userId: user._id }).lean())?.editsCount).toBe(1);
  });

  it("refuses a key change (400), and answers 404 for an unknown or malformed id", async () => {
    await loadDictionary();
    const sesame = (await Allergen.findOne({ key: "sesame" }).lean())!;
    const { agent } = await account("cleo", ["member", "curator"]);
    const body = {
      displayName: "Sesame",
      tier: "allergy",
      synonyms: ["sesame"],
      descriptionKeywords: [],
      excludePhrases: [],
    };
    await agent
      .put(`/api/allergens/${sesame._id}`)
      .send({ ...body, key: "sesame-2" })
      .expect(400);
    await agent.put("/api/allergens/0123456789abcdef01234567").send(body).expect(404);
    await agent.put("/api/allergens/nope").send(body).expect(404);
    expect((await Allergen.findById(sesame._id).lean())?.source).toBe("seed");
    // Value: protects=a refused dictionary write is not counted on the Curator's profile; fails_when=
    //   countEdit moves before the write or into a finally; why_new=only successful writes checked
    //   editsCount; seam=none; no_claim=none beyond protects
    expect((await CuratorProfile.findOne({}).lean())?.editsCount).toBe(0);
  });

  // Value: protects=an edit whose re-match runs out of time answers 202 with rematchPending, not 200;
  //   fails_when=PUT stops routing through sendWrite or hardcodes 200; why_new=only POST's 202 path was
  //   tested; seam=none; no_claim=real 60 s timing (Date.now mocked)
  it("answers 202 with the foods left when the edit's re-match runs out of time", async () => {
    await cacheFoods(501);
    await loadDictionary();
    const sesame = (await Allergen.findOne({ key: "sesame" }).lean())!;
    const { agent } = await account("cleo", ["member", "curator"]);
    slowClock();
    const res = await agent
      .put(`/api/allergens/${sesame._id}`)
      .send({
        displayName: "Sesame",
        tier: "allergy",
        synonyms: ["tahini"],
        descriptionKeywords: [],
        excludePhrases: [],
      })
      .expect(202);
    vi.restoreAllMocks();
    expect(res.body.rematch).toEqual({ done: false, processed: 500, remaining: 1 });
    expect(res.body.allergen.rematchPending).toBe(true);
  });

  it("is 403 for a member", async () => {
    await loadDictionary();
    const sesame = (await Allergen.findOne({ key: "sesame" }).lean())!;
    const { agent } = await account("mia");
    await agent.put(`/api/allergens/${sesame._id}`).send({}).expect(403);
  });
});

describe("POST /api/curate/allergens/:id/rematch", () => {
  it("is 401 without a session, 403 for a member, 404 for an unknown id", async () => {
    await request(app).post("/api/curate/allergens/0123456789abcdef01234567/rematch").expect(401);
    const { agent: member } = await account("mia");
    await member.post("/api/curate/allergens/0123456789abcdef01234567/rematch").expect(403);
    const { agent } = await account("cleo", ["member", "curator"]);
    await agent.post("/api/curate/allergens/0123456789abcdef01234567/rematch").expect(404);
    await agent.post("/api/curate/allergens/nope/rematch").expect(404);
  });

  it("picks up a re-match a write left unfinished (crash after the write, before any batch)", async () => {
    await cacheFoods(3);
    const { user, agent } = await account("cleo", ["member", "curator"]);
    // The write's own pass never ran: the entry is stored with its cursor at 0.
    const write = await createAllergen(tahini as never, user._id, { budgetMs: 0, batchSize: 1 });
    expect(write.rematch.done).toBe(false);
    expect(write.allergen.rematchPending).toBe(true);
    const res = await agent.post(`/api/curate/allergens/${write.allergen.id}/rematch`).expect(200);
    expect(res.body.done).toBe(true);
    expect(await rowsOf(write.allergen.id)).toEqual([3]);
  });

  it("an edit while a re-match is unfinished restarts it from the first food", async () => {
    await cacheFoods(6);
    const { user } = await account("cleo", ["member", "curator"]);
    const write = await createAllergen(tahini as never, user._id, { budgetMs: 0, batchSize: 2 });
    expect(write.rematch).toMatchObject({ done: false, processed: 2 });
    const edit = await updateAllergen(
      write.allergen.id,
      { ...tahini, key: undefined, synonyms: ["flour"] } as never,
      user._id,
    );
    expect(edit.rematch).toEqual({ done: true, processed: 6, remaining: 0 });
    expect(await rowsOf(write.allergen.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
