import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { UnmatchedListResponse } from "@healtheat/shared";
import app from "../src/app.js";
import {
  Allergen,
  CuratorProfile,
  Food,
  FoodAllergen,
  IngredientToken,
  IngredientTokenFood,
  User,
} from "../src/models/index.js";
import { loadDictionary, matchAndStore, unmatchedTokens } from "../src/services/dictionary.js";

afterEach(() => {
  vi.restoreAllMocks();
});
// T22: the unmatched-ingredient queue (design doc REST table, phase 3; eng review D2 distinct-food
// counts, D5 token writes isolated from matching).

async function cache(fdcId: number, ingredientsText: string) {
  const food = {
    fdcId,
    description: `F${fdcId}`,
    dataType: "Branded",
    ingredientsText,
    fetchedAt: new Date(),
  };
  await Food.create(food);
  return food;
}

describe("unmatched tokens", () => {
  it("keeps only ingredient phrases no synonym matches", async () => {
    const dictionary = await loadDictionary();
    expect(
      unmatchedTokens("SUGAR, EMULSIFIER (SOY LECITHIN), XANTHAN GUM, AB", dictionary).sort(),
    ).toEqual(["emulsifier", "sugar", "xanthan gum"]);
    expect(unmatchedTokens(null, dictionary)).toEqual([]);
  });

  // Value: protects=a token counts distinct foods: two foods give 2, matching or refreshing the same food
  //   again does not add (D2); fails_when=the count increments per match; why_new=T22 is new; seam=none;
  //   no_claim=concurrent first matches beyond the unique index
  it("counts each food once however often it is matched", async () => {
    await loadDictionary();
    const a = await cache(1, "SUGAR, EMULSIFIER (SOY LECITHIN), XANTHAN GUM");
    const b = await cache(2, "WATER, XANTHAN GUM");
    await matchAndStore(a);
    await matchAndStore(b);
    await matchAndStore(a); // a refresh or re-match of the same food
    const xanthan = (await IngredientToken.findOne({ token: "xanthan gum" }).lean())!;
    expect(xanthan).toMatchObject({ count: 2, status: "new" });
    expect(xanthan.sampleFdcIds.sort()).toEqual([1, 2]);
    expect(await IngredientToken.countDocuments({ token: "soy lecithin" })).toBe(0); // matched soy
    expect(await IngredientTokenFood.countDocuments({ token: "xanthan gum" })).toBe(2);
  });

  // Value: protects=a failing token write never changes a food's matches, rows or stamp (regression
  //   contract D5); fails_when=the token step throws out of matchAndStore or runs before the stamp;
  //   why_new=matchAndStore gained a step; seam=none; no_claim=a real database outage
  it("leaves matching, rows and stamp unchanged when recording tokens fails", async () => {
    await loadDictionary();
    const food = await cache(3, "PEANUTS, XANTHAN GUM");
    vi.spyOn(IngredientToken, "bulkWrite").mockRejectedValueOnce(new Error("disk full"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const matches = await matchAndStore(food);
    expect(matches.map((m) => m.key)).toEqual(["peanuts"]);
    expect(await FoodAllergen.countDocuments({ fdcId: 3 })).toBe(1);
    expect((await Food.findOne({ fdcId: 3 }).lean())?.allergensMatchedAt).toBeInstanceOf(Date);
  });
});

describe("/api/curate/unmatched", () => {
  async function curator(username: string) {
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
    const user = (await User.findOneAndUpdate(
      { username },
      { $set: { roles: ["member", "curator"] } },
      { new: true },
    ))!;
    await CuratorProfile.create({ userId: user._id });
    return { agent, user };
  }

  // Value: protects=mapping a token appends it as a synonym, re-matches so FoodAllergen rows appear,
  //   marks it mapped and counts the edit; ignore only marks; members get 403; fails_when=map skips the
  //   re-match or the queue shows reviewed tokens as new; why_new=new routes; seam=none; no_claim=the
  //   202 continue flow (rematch tests cover it)
  it("lists new tokens by count, maps one into the dictionary and ignores another", async () => {
    await loadDictionary();
    for (const [id, text] of [
      [10, "XANTHAN GUM, SUGAR"],
      [11, "XANTHAN GUM, CAROB"],
      [12, "CAROB"],
    ] as const)
      await matchAndStore(await cache(id, text));
    const { agent, user } = await curator("cleo");

    const list = UnmatchedListResponse.parse(
      (await agent.get("/api/curate/unmatched").expect(200)).body,
    );
    expect(list.tokens.map((t) => [t.token, t.count])).toEqual([
      ["carob", 2],
      ["xanthan gum", 2],
      ["sugar", 1],
    ]);

    const soy = (await Allergen.findOne({ key: "soy" }).lean())!;
    const mapped = await agent
      .put("/api/curate/unmatched/carob")
      .send({ action: "map", allergenId: String(soy._id) })
      .expect(200);
    expect(mapped.body.token).toMatchObject({ token: "carob", status: "mapped" });
    expect((await Allergen.findById(soy._id).lean())?.synonyms).toContain("carob");
    expect(
      (await FoodAllergen.find({ allergenId: soy._id }).lean()).map((r) => r.fdcId).sort(),
    ).toEqual([11, 12]);
    expect((await CuratorProfile.findOne({ userId: user._id }).lean())?.editsCount).toBe(1);

    await agent.put("/api/curate/unmatched/sugar").send({ action: "ignore" }).expect(200);
    const left = UnmatchedListResponse.parse(
      (await agent.get("/api/curate/unmatched").expect(200)).body,
    );
    expect(left.tokens.map((t) => t.token)).toEqual(["xanthan gum"]);
    const ignored = UnmatchedListResponse.parse(
      (await agent.get("/api/curate/unmatched?status=ignored").expect(200)).body,
    );
    expect(ignored.tokens.map((t) => t.token)).toEqual(["sugar"]);
    expect((await CuratorProfile.findOne({ userId: user._id }).lean())?.editsCount).toBe(1);

    await agent.put("/api/curate/unmatched/nothing-here").send({ action: "ignore" }).expect(404);
    await agent
      .put("/api/curate/unmatched/xanthan%20gum")
      .send({ action: "map", allergenId: "0".repeat(24) })
      .expect(404);
    await agent.put("/api/curate/unmatched/xanthan%20gum").send({ action: "delete" }).expect(400);
  });

  it("is 401 anonymous and 403 for a member", async () => {
    await request(app).get("/api/curate/unmatched").expect(401);
    const member = request.agent(app);
    await member
      .post("/api/auth/register")
      .send({
        username: "mia",
        email: "mia@example.com",
        password: "correct horse battery",
        timezone: "UTC",
      })
      .expect(201);
    await member.get("/api/curate/unmatched").expect(403);
    await member.put("/api/curate/unmatched/sugar").send({ action: "ignore" }).expect(403);
  });
});
