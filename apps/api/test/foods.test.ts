import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { FoodDetails, FoodSearchResponse } from "@healtheat/shared";
import app from "../src/app.js";
import { Food, SearchCache } from "../src/models/index.js";
import { FOOD_REFRESH_MS, USDA_BASE_URL } from "../src/services/usda.js";

// Recorded USDA FoodData Central payloads (fetched 2026-11-13 with DEMO_KEY, trimmed to the fields
// the service reads): a branded search, a Foundation food with a portion, a branded food.
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/usda/${name}.json`, import.meta.url), "utf8"));
const SEARCH = fixture("search-cheddar");
const APPLE = fixture("food-foundation-apple");
const CHEDDAR = fixture("food-branded-cheddar");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
const usdaCalls = () => fetchMock.mock.calls.map(([u]) => new URL(String(u)));

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

describe("GET /api/foods/search", () => {
  it("proxies USDA once, normalizes the page and serves the next equal search from the cache", async () => {
    fetchMock.mockResolvedValueOnce(json(SEARCH));
    const res = await request(app).get("/api/foods/search?q=cheddar%20cheese").expect(200);
    const body = FoodSearchResponse.parse(res.body);
    expect(body).toMatchObject({ query: "cheddar cheese", dataType: null, page: 1, pageSize: 25 });
    expect(body.cached).toBe(false);
    expect(body.totalHits).toBe(60863);
    expect(body.foods).toHaveLength(3);
    expect(body.foods[0]).toMatchObject({
      fdcId: 2095236,
      description: "CHEDDAR CHEESE",
      dataType: "Branded",
      brandOwner: "MDS Foods Inc.",
    });
    expect(body.foods[0].ingredientsText).toMatch(/^MILK, CHEESE CULTURES/);
    // Headline nutrients only, per 100 g, with readable units.
    expect(body.foods[0].nutrients).toContainEqual({
      nutrientId: 1003,
      name: "Protein",
      unit: "g",
      amountPer100g: 25,
    });
    expect(body.foods[0].nutrients.find((n) => n.nutrientId === 1008)?.unit).toBe("kcal");
    expect(
      body.foods[0].nutrients.every((n) =>
        [1008, 2047, 2048, 1003, 1004, 1005].includes(n.nutrientId),
      ),
    ).toBe(true);

    const [url] = usdaCalls();
    expect(url.origin + url.pathname).toBe(`${USDA_BASE_URL}/foods/search`);
    expect(url.searchParams.get("query")).toBe("cheddar cheese");
    expect(url.searchParams.get("pageSize")).toBe("25");
    expect(url.searchParams.get("pageNumber")).toBe("1");
    expect(url.searchParams.get("api_key")).toBe("DEMO_KEY");
    expect(JSON.stringify(res.body)).not.toContain("DEMO_KEY");

    // Same search, different case and spacing: one shared cache entry, no second USDA call.
    const again = await request(app)
      .get("/api/foods/search?q=%20Cheddar%20%20CHEESE%20")
      .expect(200);
    expect(again.body.foods).toEqual(body.foods);
    expect(again.body.cached).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await SearchCache.countDocuments()).toBe(1);
  });

  it("passes the data type and page to USDA and keys the cache on them", async () => {
    fetchMock.mockImplementation(async () => json(SEARCH));
    await request(app).get("/api/foods/search?q=apple&dataType=Foundation&page=3").expect(200);
    await request(app).get("/api/foods/search?q=apple&dataType=Foundation&page=4").expect(200);
    const [first, second] = usdaCalls();
    expect(first.searchParams.get("dataType")).toBe("Foundation");
    expect(first.searchParams.get("pageNumber")).toBe("3");
    expect(second.searchParams.get("pageNumber")).toBe("4");
    expect(await SearchCache.countDocuments()).toBe(2);
  });

  it("serves an older cached page labelled cached when USDA answers 429", async () => {
    fetchMock.mockResolvedValueOnce(json(SEARCH));
    await request(app).get("/api/foods/search?q=cheddar").expect(200);
    await SearchCache.updateMany({}, { $set: { createdAt: hoursAgo(2) } });
    fetchMock.mockResolvedValueOnce(json({ error: "rate limited" }, 429));
    const res = await request(app).get("/api/foods/search?q=cheddar").expect(200);
    expect(FoodSearchResponse.parse(res.body).cached).toBe(true);
    expect(res.body.foods).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes an older cached page when USDA answers", async () => {
    fetchMock.mockImplementation(async () => json(SEARCH));
    await request(app).get("/api/foods/search?q=cheddar").expect(200);
    const old = hoursAgo(2);
    await SearchCache.updateMany({}, { $set: { createdAt: old } });
    const res = await request(app).get("/api/foods/search?q=cheddar").expect(200);
    expect(res.body.cached).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const entry = await SearchCache.findOne().lean();
    expect(entry!.createdAt.getTime()).toBeGreaterThan(old.getTime());
  });

  it.each([
    ["a 5xx", () => fetchMock.mockResolvedValueOnce(json({}, 502))],
    ["a 429", () => fetchMock.mockResolvedValueOnce(json({}, 429))],
    ["a rejected key (403)", () => fetchMock.mockResolvedValueOnce(json({}, 403))],
    ["a network error", () => fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"))],
  ])("answers 503 usda_unavailable on %s with nothing cached", async (_name, arrange) => {
    arrange();
    const res = await request(app).get("/api/foods/search?q=cheddar").expect(503);
    expect(res.body).toEqual({
      error: "usda_unavailable",
      details: "USDA is unavailable right now, try again in a few minutes",
    });
    expect(await SearchCache.countDocuments()).toBe(0);
  });

  it.each([
    ["no q", "/api/foods/search"],
    ["a blank q", "/api/foods/search?q=%20%20"],
    ["page 0", "/api/foods/search?q=apple&page=0"],
    ["a page past the cap", "/api/foods/search?q=apple&page=201"],
    ["an unknown data type", "/api/foods/search?q=apple&dataType=Fake"],
  ])("rejects %s with 400 before calling USDA", async (_name, path) => {
    const res = await request(app).get(path).expect(400);
    expect(res.body.error).toBe("validation_error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 503 usda_unconfigured on a deployment without a USDA key", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("SESSION_SECRET", "a-real-deployment-secret");
    vi.stubEnv("MONGODB_DB", "healtheat_test");
    vi.stubEnv("USDA_API_KEY", "");
    const res = await request(app).get("/api/foods/search?q=apple").expect(503);
    expect(res.body.error).toBe("usda_unconfigured");
    expect(res.body.details).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the configured key, never DEMO_KEY, when USDA_API_KEY is set", async () => {
    vi.stubEnv("USDA_API_KEY", "configured-key-value");
    fetchMock.mockResolvedValueOnce(json(SEARCH));
    const res = await request(app).get("/api/foods/search?q=apple").expect(200);
    expect(usdaCalls()[0].searchParams.get("api_key")).toBe("configured-key-value");
    expect(JSON.stringify(res.body)).not.toContain("configured-key-value");
  });

  it("stores the page with a 24-hour TTL index on a unique key", async () => {
    await SearchCache.init();
    const indexes = await SearchCache.collection.indexes();
    expect(indexes.find((i) => i.key.createdAt === 1)?.expireAfterSeconds).toBe(86400);
    expect(indexes.find((i) => i.key.key === 1)?.unique).toBe(true);
  });
});

describe("GET /api/foods/:fdcId", () => {
  it("normalizes a Foundation food, stores it and serves the next read without USDA", async () => {
    fetchMock.mockResolvedValueOnce(json(APPLE));
    const res = await request(app).get("/api/foods/1750340").expect(200);
    const body = FoodDetails.parse(res.body);
    expect(body).toMatchObject({
      fdcId: 1750340,
      description: "Apples, fuji, with skin, raw",
      dataType: "Foundation",
      brandOwner: null,
      ingredientsText: null,
      cached: false,
    });
    // Group headers ("Proximates", no amount) are skipped; every row has a number per 100 g.
    expect(body.nutrients.map((n) => n.name)).not.toContain("Proximates");
    expect(body.nutrients).toContainEqual(
      expect.objectContaining({ nutrientId: 2047, unit: "kcal", amountPer100g: 64.6609 }),
    );
    expect(body.servingSizes).toEqual([{ label: "1 serving (reference amount)", grams: 140 }]);
    expect(usdaCalls()[0].pathname).toBe("/fdc/v1/food/1750340");

    const again = await request(app).get("/api/foods/1750340").expect(200);
    expect(again.body).toEqual(res.body);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await Food.countDocuments({ fdcId: 1750340 })).toBe(1);
  });

  it("keeps a branded food's owner, ingredients and label serving", async () => {
    fetchMock.mockResolvedValueOnce(json(CHEDDAR));
    const res = await request(app).get("/api/foods/2095236").expect(200);
    const body = FoodDetails.parse(res.body);
    expect(body.brandOwner).toBe("MDS Foods Inc.");
    expect(body.ingredientsText).toMatch(/^MILK, CHEESE CULTURES, SALT/);
    expect(body.servingSizes).toEqual([{ label: "1 ONZ (28 g)", grams: 28 }]);
    expect(body.nutrients).toContainEqual(
      expect.objectContaining({ nutrientId: 1008, unit: "kcal", amountPer100g: 432 }),
    );
  });

  it("serves an outdated stored food labelled cached when USDA fails, and refreshes it when USDA answers", async () => {
    fetchMock.mockResolvedValueOnce(json(APPLE));
    await request(app).get("/api/foods/1750340").expect(200);
    const old = new Date(Date.now() - FOOD_REFRESH_MS - 60_000);
    await Food.updateOne({ fdcId: 1750340 }, { $set: { fetchedAt: old } });

    fetchMock.mockResolvedValueOnce(json({}, 503));
    const stale = await request(app).get("/api/foods/1750340").expect(200);
    expect(stale.body.cached).toBe(true);
    expect(stale.body.description).toBe("Apples, fuji, with skin, raw");

    fetchMock.mockResolvedValueOnce(json(APPLE));
    const fresh = await request(app).get("/api/foods/1750340").expect(200);
    expect(fresh.body.cached).toBe(false);
    const stored = await Food.findOne({ fdcId: 1750340 }).lean();
    expect(stored!.fetchedAt.getTime()).toBeGreaterThan(old.getTime());
  });

  it("answers 404 food_not_found for an id USDA does not know", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 404));
    const res = await request(app).get("/api/foods/999999999").expect(404);
    expect(res.body.error).toBe("food_not_found");
    expect(await Food.countDocuments()).toBe(0);
  });

  it("answers 503 usda_unavailable on a 429 for a food it has never stored", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 429));
    const res = await request(app).get("/api/foods/1750340").expect(503);
    expect(res.body.error).toBe("usda_unavailable");
  });

  it.each(["abc", "0", "-5", "1.5"])(
    "rejects the id %s with 400 before calling USDA",
    async (id) => {
      await request(app).get(`/api/foods/${id}`).expect(400);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("stores foods under a unique fdcId", async () => {
    await Food.init();
    const indexes = await Food.collection.indexes();
    expect(indexes.find((i) => i.key.fdcId === 1)?.unique).toBe(true);
  });
});
