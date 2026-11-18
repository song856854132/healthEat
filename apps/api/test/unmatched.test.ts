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
    // Value: protects=queue phrases are what matchFood leaves unmatched: an exclude phrase hides its
    //   allergen word, a repeated phrase is one token, a phrase over 80 characters is dropped;
    //   fails_when=unmatchedTokens skips mask(), loses the Set or the upper bound; why_new=only the
    //   lower bound and a plain synonym hit were checked; seam=none; no_claim=none beyond protects
    expect(
      unmatchedTokens(`CRAB APPLE, SUGAR, SUGAR, ${"MALTODEXTRIN ".repeat(7)}, CRAB`, dictionary),
    ).toEqual(["crab apple", "sugar"]);
  });

  // Value: protects=a refreshed food that gains one phrase raises only that phrase's count, and a
  //   token keeps at most five sample foods; fails_when=a partly duplicate insert counts every pair or
  //   none, or the $slice is dropped; why_new=only an all-duplicate re-match was tested; seam=none;
  //   no_claim=insertedIds semantics of other driver versions (mongodb 7 on mongodb-memory-server)
  it("counts only the phrase a refreshed food gains, and keeps five sample foods", async () => {
    await loadDictionary();
    for (let id = 20; id < 26; id++) await matchAndStore(await cache(id, "XANTHAN GUM"));
    await matchAndStore(await cache(26, "XANTHAN GUM"));
    const refreshed = { ...(await Food.findOne({ fdcId: 26 }).lean())!, fetchedAt: new Date() };
    await Food.updateOne(
      { fdcId: 26 },
      { $set: { ingredientsText: "XANTHAN GUM, CAROB", fetchedAt: refreshed.fetchedAt } },
    );
    await matchAndStore({ ...refreshed, ingredientsText: "XANTHAN GUM, CAROB" });
    const xanthan = (await IngredientToken.findOne({ token: "xanthan gum" }).lean())!;
    expect(xanthan.count).toBe(7);
    expect(xanthan.sampleFdcIds).toEqual([20, 21, 22, 23, 24]);
    expect(await IngredientToken.findOne({ token: "carob" }).lean()).toMatchObject({
      count: 1,
      sampleFdcIds: [26],
    });
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

  // Value: protects=the queue pages 20 at a time with the full total, and a page below 1 is a 400;
  //   fails_when=skip ignores the page, total counts the page only, or page=0 reaches Mongo;
  //   why_new=only page 1 with three tokens was listed; seam=none; no_claim=none beyond protects
  it("pages the queue twenty at a time and rejects page 0", async () => {
    await IngredientToken.insertMany(
      Array.from({ length: 21 }, (_, i) => ({ token: `phrase ${100 + i}`, count: 100 - i })),
    );
    const { agent } = await curator("cleo");
    const first = UnmatchedListResponse.parse(
      (await agent.get("/api/curate/unmatched").expect(200)).body,
    );
    expect(first.tokens).toHaveLength(20);
    expect(first.total).toBe(21);
    const second = UnmatchedListResponse.parse(
      (await agent.get("/api/curate/unmatched?page=2").expect(200)).body,
    );
    expect(second).toMatchObject({ page: 2, total: 21 });
    expect(second.tokens.map((t) => t.token)).toEqual(["phrase 120"]);
    await agent.get("/api/curate/unmatched?page=0").expect(400);
  });

  // Value: protects=the URL token is normalised before lookup, and mapping a phrase the allergen
  //   already lists does not add it twice; fails_when=actOnToken drops normalize() or the
  //   already-listed check; why_new=the map test used a lowercase token once; seam=none;
  //   no_claim=none beyond protects
  it("maps a token given in any case once, however often it is mapped", async () => {
    await loadDictionary();
    await matchAndStore(await cache(30, "CAROB"));
    const { agent, user } = await curator("cleo");
    const soy = (await Allergen.findOne({ key: "soy" }).lean())!;
    for (const path of ["/api/curate/unmatched/Carob", "/api/curate/unmatched/CAROB"])
      await agent
        .put(path)
        .send({ action: "map", allergenId: String(soy._id) })
        .expect(200);
    const synonyms = (await Allergen.findById(soy._id).lean())!.synonyms;
    expect(synonyms.filter((s) => s === "carob")).toHaveLength(1);
    expect((await CuratorProfile.findOne({ userId: user._id }).lean())?.editsCount).toBe(2);
  });

  // Value: protects=a map whose re-match runs out of time answers 202 with the foods left, and the
  //   token is still marked mapped; fails_when=the route hardcodes 200 or tests write instead of
  //   write.rematch.done; why_new=the map test's re-match always finished; seam=none;
  //   no_claim=real 60 s timing (Date.now mocked, as in curate.test.ts)
  it("answers 202 when the map's re-match runs out of time", async () => {
    await loadDictionary();
    await Food.insertMany(
      Array.from({ length: 501 }, (_, i) => ({
        fdcId: 1000 + i,
        description: `F${i}`,
        dataType: "Branded",
        ingredientsText: "CAROB",
        fetchedAt: new Date(),
      })),
    );
    await IngredientToken.create({ token: "carob", count: 501 });
    const soy = (await Allergen.findOne({ key: "soy" }).lean())!;
    const { agent } = await curator("cleo");
    let t = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => (t += 61_000));
    const res = await agent
      .put("/api/curate/unmatched/carob")
      .send({ action: "map", allergenId: String(soy._id) })
      .expect(202);
    vi.restoreAllMocks();
    expect(res.body.write.rematch).toEqual({ done: false, processed: 500, remaining: 1 });
    expect(res.body.token).toMatchObject({ token: "carob", status: "mapped" });
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
