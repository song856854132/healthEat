import { describe, expect, it } from "vitest";
import request from "supertest";
import { GapFoodsResponse, TRACKED_NUTRIENTS } from "@healtheat/shared";
import type { Types } from "mongoose";
import app from "../src/app.js";
import { Allergen, Food, User, UserAllergen } from "../src/models/index.js";
import { loadDictionary } from "../src/services/dictionary.js";
import { rankGapFoods } from "../src/services/gaps.js";

// T26: close the gap (design doc, Core algorithms; eng review D3 shipped seed data, D8 avoid filter on
// seed and unstamped foods, D12 whole-food candidates with a kcal floor).

const VITAMIN_E = 1109;
const kcal = (v: number) => ({ nutrientId: 1008, amountPer100g: v });
const vitE = (v: number) => ({ nutrientId: VITAMIN_E, amountPer100g: v });

describe("rankGapFoods", () => {
  // Value: protects=ranking is amount per kcal with a 20 kcal floor, skips unreported nutrients, keeps
  //   6, and sizes a portion from the first serving; fails_when=near-zero-kcal foods rank first or a
  //   missing nutrient reads 0; why_new=new ranking; seam=none; no_claim=nutrition advice quality
  it("orders by amount per kcal, drops low-kcal and unreported foods, keeps six", () => {
    const c = (
      fdcId: number,
      nutrients: { nutrientId: number; amountPer100g: number }[],
      servingGrams: number | null = null,
    ) => ({
      fdcId,
      description: `F${fdcId}`,
      source: "seed" as const,
      nutrients,
      servingGrams,
    });
    const ranked = rankGapFoods(
      [
        c(1, [kcal(100), vitE(1)]),
        c(2, [kcal(100), vitE(5)], 30),
        c(3, [kcal(10), vitE(50)]), // under the kcal floor
        c(4, [kcal(100)]), // does not report vitamin E
        c(5, [vitE(9)]), // no energy
        c(6, [kcal(100), vitE(0)]),
        ...[7, 8, 9, 10, 11].map((id) => c(id, [kcal(100), vitE(2)])),
      ],
      VITAMIN_E,
    );
    expect(ranked.map((f) => f.fdcId)).toEqual([2, 7, 8, 9, 10, 11]);
    expect(ranked[0]).toMatchObject({ portionGrams: 30, amountPerPortion: 1.5, kcalPer100g: 100 });
    expect(ranked[1].portionGrams).toBe(100);
  });
});

describe("GET /api/users/me/gaps/:nutrientId/foods", () => {
  async function member(username: string) {
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
    return { agent, user: (await User.findOne({ username }))! };
  }
  const avoid = async (userId: Types.ObjectId, key: string) => {
    const a = (await Allergen.findOne({ key }).lean())!;
    await UserAllergen.create({ userId, allergenId: a._id, mode: "avoid" });
  };
  const names = async (agent: ReturnType<typeof request.agent>, id: number) =>
    GapFoodsResponse.parse(
      (await agent.get(`/api/users/me/gaps/${id}/foods`).expect(200)).body,
    ).foods.map((f) => f.description);

  // Value: protects=a member never gets a seed food carrying an allergen they avoid (D8): almonds for a
  //   tree-nut avoider, peanuts for a peanut avoider, for every tracked nutrient; fails_when=seed foods
  //   skip in-memory matching; why_new=seed foods have no FoodAllergen rows; seam=none; no_claim=matcher
  //   recall on descriptions outside the seed list
  it("never suggests a shipped whole food with an avoided allergen", async () => {
    await loadDictionary();
    const { agent: free } = await member("free");
    const { agent: nutty, user } = await member("nutty");
    await avoid(user._id, "tree-nuts");
    await avoid(user._id, "peanuts");
    const forFree = await names(free, VITAMIN_E);
    expect(forFree).toContain("Nuts, almonds");
    const forNutty = await names(nutty, VITAMIN_E);
    expect(forNutty).not.toContain("Nuts, almonds");
    expect(forNutty.length).toBeGreaterThan(0);
    for (const t of TRACKED_NUTRIENTS) {
      const list = await names(nutty, t.id);
      expect(list.filter((n) => /\b(peanut|almond|walnut|cashew)/i.test(n))).toEqual([]);
    }
  });

  // Value: protects=a cached whole food not yet matched (unstamped) is matched before ranking, so an
  //   avoided allergen in its ingredients excludes it; branded and low-kcal foods are not candidates;
  //   fails_when=unstamped foods pass with no rows, or the dataType/kcal filters drop; why_new=D8, D12;
  //   seam=none; no_claim=real USDA copies
  it("matches unstamped cached foods first and skips branded and low-kcal ones", async () => {
    await loadDictionary();
    await Food.create([
      {
        fdcId: 900001,
        description: "PEANUT FLOUR",
        dataType: "SR Legacy",
        ingredientsText: "PEANUTS",
        fetchedAt: new Date(),
        nutrients: [kcal(400), vitE(200)].map((n) => ({ ...n, name: "x", unit: "MG" })),
      },
      {
        fdcId: 900002,
        description: "FORTIFIED WATER",
        dataType: "SR Legacy",
        fetchedAt: new Date(),
        nutrients: [kcal(5), vitE(50)].map((n) => ({ ...n, name: "x", unit: "MG" })),
      },
      {
        fdcId: 900003,
        description: "VITAMIN BAR",
        dataType: "Branded",
        fetchedAt: new Date(),
        nutrients: [kcal(300), vitE(300)].map((n) => ({ ...n, name: "x", unit: "MG" })),
      },
    ]);
    const { agent: free } = await member("free");
    const { agent: avoider, user } = await member("avoider");
    await avoid(user._id, "peanuts");
    const forFree = GapFoodsResponse.parse(
      (await free.get(`/api/users/me/gaps/${VITAMIN_E}/foods`).expect(200)).body,
    );
    expect(forFree.foods[0]).toMatchObject({ fdcId: 900001, source: "cache" });
    expect(forFree.foods.map((f) => f.fdcId)).not.toContain(900002);
    expect(forFree.foods.map((f) => f.fdcId)).not.toContain(900003);
    const forAvoider = await names(avoider, VITAMIN_E);
    expect(forAvoider).not.toContain("PEANUT FLOUR");
    expect((await Food.findOne({ fdcId: 900001 }).lean())?.allergensMatchedAt).toBeInstanceOf(Date);
  });

  it("is 401 anonymous and 404 for an untracked or malformed nutrient id", async () => {
    await request(app).get(`/api/users/me/gaps/${VITAMIN_E}/foods`).expect(401);
    const { agent } = await member("mia");
    expect((await agent.get("/api/users/me/gaps/1008/foods").expect(404)).body.error).toBe(
      "nutrient_not_tracked",
    );
    await agent.get("/api/users/me/gaps/abc/foods").expect(404);
    const res = GapFoodsResponse.parse(
      (await agent.get("/api/users/me/gaps/1162/foods").expect(200)).body,
    );
    expect(res.nutrient).toEqual({ id: 1162, key: "vitaminC", name: "Vitamin C", unit: "mg" });
    expect(res.foods).toHaveLength(6);
  });
});
