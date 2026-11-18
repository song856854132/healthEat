import type { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { SummaryResponse, TRACKED_NUTRIENTS, driRow, referenceRow } from "@healtheat/shared";
import app from "../src/app.js";
import {
  Allergen,
  Food,
  FoodAllergen,
  LogEntry,
  MemberProfile,
  User,
  UserAllergen,
} from "../src/models/index.js";
import { allergensForFoods, loadDictionary } from "../src/services/dictionary.js";
import {
  amountPer100g,
  bandStatus,
  calorieBandFor,
  calorieMeter,
  computeBands,
  computeDays,
  kcalOf,
  targetsFor,
  weekDates,
  type NutrientRow,
} from "../src/services/summary.js";

// T25: the weekly summary (design doc, Core algorithms; eng review 2026-11-18 decisions D4, D7, D9, D11).

const TODAY = "2026-11-16";
const VIT_D = TRACKED_NUTRIENTS.find((t) => t.key === "vitaminD")!;

describe("summary pure functions", () => {
  // Value: protects=a nutrient is read from its canonical id, else an alternate converted to the unit,
  //   and a food that does not report it is unknown (null), not 0; fails_when=IU is not converted or a
  //   missing nutrient reads 0; why_new=summary.ts is new; seam=none; no_claim=USDA id coverage beyond these
  it("reads a nutrient from its id or a converted alternate, and null when unreported", () => {
    expect(amountPer100g([{ nutrientId: 1114, amountPer100g: 2 }], VIT_D)).toBe(2);
    expect(amountPer100g([{ nutrientId: 1110, amountPer100g: 400 }], VIT_D)).toBe(10);
    expect(amountPer100g([{ nutrientId: 1003, amountPer100g: 5 }], VIT_D)).toBeNull();
  });

  // Value: protects=targets come from the member's sex and age band, else the labelled reference row
  //   (D9); fails_when=an unspecified sex or missing birth year throws or picks a random row;
  //   why_new=new contract; seam=none; no_claim=clinical accuracy of the DRI values
  it("picks the personal DRI row from sex and age, else the reference row", () => {
    const personal = targetsFor({ sex: "female", birthYear: 1990 }, TODAY);
    expect(personal.basis).toBe("personal");
    expect(personal.key).toBe("female-31-50");
    expect(targetsFor({ sex: "male", birthYear: 2010 }, TODAY).key).toBe("male-14-18");
    expect(targetsFor({ sex: "male", birthYear: 1950 }, TODAY).key).toBe("male-71+");
    const ref = targetsFor({ sex: "unspecified", birthYear: 1990 }, TODAY);
    expect(ref).toMatchObject({ basis: "reference", key: "reference-adult" });
    expect(targetsFor(null, TODAY).basis).toBe("reference");
    // Coverage audit pass 2: a known sex without a birth year is still the reference row, not a NaN age band.
    expect(targetsFor({ sex: "female", birthYear: null }, TODAY).key).toBe("reference-adult");
    // The reference row never understates a need and never overstates a safe ceiling.
    const r = referenceRow();
    expect(r.iron).toEqual({ target: 18, upper: 45 });
    expect(r.vitaminC.target).toBe(90);
    expect(r.calcium.upper).toBe(2500);
    expect(driRow("female", "51-70").calcium).toEqual({ target: 1200, upper: 2000 });
  });

  // Value: protects=the calorie band is the member's own, else Mifflin-St Jeor +/-10%, else null when
  //   any input is missing (D4); fails_when=a band is guessed for an incomplete profile; why_new=new
  //   contract; seam=none; no_claim=accuracy of the formula for an individual
  it("uses the set band, else a computed band, else none for an incomplete profile", () => {
    expect(calorieBandFor({ calorieBand: { low: 1800, high: 2200 } }, TODAY)).toEqual({
      low: 1800,
      high: 2200,
      basis: "set",
    });
    const full = {
      sex: "female",
      birthYear: 1990,
      heightCm: 165,
      weightKg: 60,
      activityLevel: "sedentary",
    };
    // BMR = 600 + 1031.25 - 180 - 161 = 1290.25; x 1.2 = 1548.3; +/-10% rounded to 10.
    expect(calorieBandFor(full, TODAY)).toEqual({ low: 1390, high: 1700, basis: "computed" });
    // Male: BMR 1456.25 x 1.2 = 1747.5, low 1572.75 rounds to 1570.
    expect(calorieBandFor({ ...full, sex: "male" }, TODAY)?.low).toBe(1570);
    for (const missing of ["sex", "birthYear", "heightCm", "weightKg"] as const)
      expect(
        calorieBandFor({ ...full, [missing]: missing === "sex" ? "unspecified" : null }, TODAY),
      ).toBeNull();
    expect(calorieBandFor(null, TODAY)).toBeNull();
    expect(calorieBandFor({ ...full, activityLevel: "odd" }, TODAY)?.basis).toBe("computed");
    // Coverage audit pass 2. Value: protects=a half-set band (low only) is not used, and a missing
    //   activity level means "light" (x1.375); fails_when=a band with high null is returned as "set" or a
    //   missing level drops to sedentary/NaN; why_new=rows above always set both ends and a level;
    //   seam=none; no_claim=none beyond protects
    // BMR 1290.25 x 1.375 = 1774.09; low 1596.7 -> 1600, high 1951.5 -> 1950.
    const light = { low: 1600, high: 1950, basis: "computed" };
    expect(calorieBandFor({ ...full, activityLevel: null }, TODAY)).toEqual(light);
    expect(
      calorieBandFor(
        { ...full, activityLevel: null, calorieBand: { low: 1800, high: null } },
        TODAY,
      ),
    ).toEqual(light);
  });

  it("puts today's kcal under, on or over the band", () => {
    const band = { low: 1800, high: 2200, basis: "set" as const };
    expect(calorieMeter(1500, band).status).toBe("under");
    expect(calorieMeter(1800, band).status).toBe("on");
    expect(calorieMeter(2200, band).status).toBe("on");
    expect(calorieMeter(2200.6, band)).toMatchObject({ status: "over", kcal: 2201 });
  });

  // Value: protects=band edges follow the doc (below 0.70 low, above 1.30 or the UL high);
  //   fails_when=a boundary flips (< vs <=) or the UL is ignored; why_new=new; seam=none; no_claim=none
  it("classifies bands at the 0.70 and 1.30 edges and against an upper line", () => {
    expect(bandStatus(69.9, 100, null)).toBe("low");
    expect(bandStatus(70, 100, null)).toBe("ok");
    expect(bandStatus(130, 100, null)).toBe("ok");
    expect(bandStatus(130.1, 100, null)).toBe("high");
    expect(bandStatus(2400, 1500, 2300)).toBe("high");
    expect(bandStatus(2200, 1500, 2300)).toBe("ok");
  });

  it("lists the 7 dates ending on a day, across a month boundary", () => {
    expect(weekDates("2026-12-02")).toEqual([
      "2026-11-26",
      "2026-11-27",
      "2026-11-28",
      "2026-11-29",
      "2026-11-30",
      "2026-12-01",
      "2026-12-02",
    ]);
  });

  // Value: protects=the design doc's demo check (vitamin E 41% -> 90% after 28 g sunflower seeds) and
  //   coverage over logged days only; fails_when=coverage divides by 7 or ignores grams; why_new=new;
  //   seam=none; no_claim=USDA values of real foods
  it("passes the design doc's vitamin E demo check, over logged days only", () => {
    const nutrients = new Map<number, NutrientRow[]>([
      [1, [{ nutrientId: 1109, amountPer100g: 6.15 }]],
      [2, [{ nutrientId: 1109, amountPer100g: 26.43 }]],
    ]);
    const row = driRow("female", "31-50"); // vitamin E target 15 mg
    const before = computeBands(
      [{ date: TODAY, fdcId: 1, grams: 100, source: "search" }],
      nutrients,
      row,
    );
    const e1 = before.find((b) => b.key === "vitaminE")!;
    expect(e1.coverage).toBeCloseTo(0.41, 2);
    expect(e1.status).toBe("low");
    const after = computeBands(
      [
        { date: TODAY, fdcId: 1, grams: 100, source: "search" },
        { date: TODAY, fdcId: 2, grams: 28, source: "search" },
      ],
      nutrients,
      row,
    );
    const e2 = after.find((b) => b.key === "vitaminE")!;
    expect(e2.coverage).toBeCloseTo(0.903, 2);
    expect(e2.status).toBe("ok");
    // A second logged day with the same intake keeps the average; an unlogged day changes nothing.
    const twoDays = computeBands(
      [
        { date: TODAY, fdcId: 1, grams: 100, source: "search" },
        { date: "2026-11-10", fdcId: 1, grams: 100, source: "search" },
      ],
      nutrients,
      row,
    );
    expect(twoDays.find((b) => b.key === "vitaminE")!.coverage).toBeCloseTo(0.41, 2);
  });

  // Value: protects=a nutrient most of the week's grams do not report is "insufficient", not "low",
  //   and an empty week is "empty" (D11); fails_when=missing data reads as zero intake; why_new=new
  //   contract; seam=none; no_claim=the 50% cutoff's fit for every nutrient
  it("marks bands empty with no logs and insufficient below half the grams reporting", () => {
    const row = driRow("male", "19-30");
    expect(computeBands([], new Map(), row).every((b) => b.status === "empty")).toBe(true);
    const nutrients = new Map<number, NutrientRow[]>([
      [1, [{ nutrientId: 1162, amountPer100g: 50 }]],
      [2, []],
    ]);
    const bands = computeBands(
      [
        { date: TODAY, fdcId: 1, grams: 40, source: "search" },
        { date: TODAY, fdcId: 2, grams: 60, source: "search" },
      ],
      nutrients,
      row,
    );
    const c = bands.find((b) => b.key === "vitaminC")!;
    expect(c).toMatchObject({ status: "insufficient", coverage: null, dataCoverage: 0.4 });
    const half = computeBands(
      [
        { date: TODAY, fdcId: 1, grams: 50, source: "search" },
        { date: TODAY, fdcId: 2, grams: 50, source: "search" },
      ],
      nutrients,
      row,
    ).find((b) => b.key === "vitaminC")!;
    expect(half.dataCoverage).toBe(0.5);
    expect(half.status).not.toBe("insufficient");

    // Coverage audit pass 2. Value: protects=a logged food with no stored nutrients counts as unknown, a
    //   week of 0 g entries is "insufficient" (not 0/0), and a nutrient the DRI row lacks never divides by a
    //   0 target; fails_when=the ?? fallbacks or the target <= 0 guard are dropped (NaN/Infinity coverage);
    //   why_new=rows above always have a food row, grams and a full DRI row; seam=none; no_claim=none
    const missingFood = computeBands(
      [
        { date: TODAY, fdcId: 1, grams: 40, source: "search" },
        { date: TODAY, fdcId: 99, grams: 60, source: "search" },
      ],
      nutrients,
      row,
    ).find((b) => b.key === "vitaminC")!;
    expect(missingFood).toMatchObject({ status: "insufficient", dataCoverage: 0.4 });
    const zeroGrams = computeBands(
      [{ date: TODAY, fdcId: 1, grams: 0, source: "photo" }],
      nutrients,
      row,
    );
    expect(zeroGrams.every((b) => b.status === "insufficient" && b.dataCoverage === 0)).toBe(true);
    const noVitC = { ...row };
    delete noVitC.vitaminC;
    const noTarget = computeBands(
      [{ date: TODAY, fdcId: 1, grams: 100, source: "search" }],
      nutrients,
      noVitC,
    ).find((b) => b.key === "vitaminC")!;
    expect(noTarget).toMatchObject({
      target: 0,
      upper: null,
      coverage: null,
      status: "insufficient",
    });
  });

  it("reports day dots with the searched share of each day's grams", () => {
    const days = computeDays(
      [
        { date: TODAY, fdcId: 1, grams: 70, source: "search" },
        { date: TODAY, fdcId: 2, grams: 30, source: "photo" },
        { date: "2026-11-15", fdcId: 1, grams: 0, source: "photo" },
      ],
      weekDates(TODAY),
    );
    expect(days[6]).toEqual({ date: TODAY, logged: true, confidence: 0.7 });
    expect(days[5]).toEqual({ date: "2026-11-15", logged: true, confidence: 1 });
    expect(days[0]).toEqual({ date: "2026-11-10", logged: false, confidence: null });
  });

  it("sums kcal from 1008 or the Atwater ids, skipping foods without energy", () => {
    const nutrients = new Map<number, NutrientRow[]>([
      [1, [{ nutrientId: 1008, amountPer100g: 200 }]],
      [2, [{ nutrientId: 2047, amountPer100g: 100 }]],
      [3, []],
    ]);
    const entries = [1, 2, 3].map((fdcId) => ({ date: TODAY, fdcId, grams: 50, source: "search" }));
    expect(kcalOf(entries, nutrients)).toBe(150);
    // Coverage audit pass 2: an entry whose food row is missing adds nothing instead of throwing.
    expect(
      kcalOf([...entries, { date: TODAY, fdcId: 99, grams: 50, source: "search" }], nutrients),
    ).toBe(150);
  });
});

describe("allergensForFoods", () => {
  // Value: protects=the batched lookup returns stored matches for stamped foods and matches unstamped
  //   ones first (D7); fails_when=unstamped foods are skipped or a deleted allergen shows; why_new=new
  //   batch function; seam=none; no_claim=query count (not asserted)
  it("reads stamped foods in one batch and matches unstamped ones", async () => {
    await loadDictionary();
    const peanut = (await Allergen.findOne({ key: "peanuts" }).lean())!;
    await Food.create([
      {
        fdcId: 1,
        description: "PEANUT BAR",
        dataType: "Branded",
        ingredientsText: "PEANUTS",
        fetchedAt: new Date(),
        allergensMatchedAt: new Date(),
      },
      {
        fdcId: 2,
        description: "SALT",
        dataType: "Branded",
        ingredientsText: "SALT",
        fetchedAt: new Date(),
        allergensMatchedAt: new Date(),
      },
      {
        fdcId: 3,
        description: "PEANUT BUTTER",
        dataType: "Branded",
        ingredientsText: "PEANUTS, SALT",
        fetchedAt: new Date(),
      },
    ]);
    await FoodAllergen.create({
      fdcId: 1,
      allergenId: peanut._id,
      matchKind: "ingredient",
      matchedSynonym: "peanuts",
      matchedAt: new Date(),
    });
    const foods = await Food.find().lean();
    const out = await allergensForFoods(foods);
    expect(out.get(1)?.map((m) => m.key)).toEqual(["peanuts"]);
    expect(out.get(2)).toEqual([]);
    expect(out.get(3)?.map((m) => m.key)).toEqual(["peanuts"]);
    expect((await Food.findOne({ fdcId: 3 }).lean())?.allergensMatchedAt).toBeInstanceOf(Date);
    expect((await allergensForFoods([])).size).toBe(0);
  });
});

describe("GET /api/users/me/summary", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

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

  // Value: protects=the summary route returns the member's own week with bands, meter, exposure and
  //   today's alerts, and nobody else's logs; fails_when=another member's logs leak in, alerts include
  //   past days, or reference basis is not labelled; why_new=new route; seam=none; no_claim=web rendering
  it("summarises the member's own week with reference targets, exposure and today's alerts", async () => {
    await loadDictionary();
    const peanut = (await Allergen.findOne({ key: "peanuts" }).lean())!;
    const milk = (await Allergen.findOne({ key: "milk" }).lean())!;
    await Food.create([
      {
        fdcId: 10,
        description: "PEANUT BAR",
        dataType: "Branded",
        ingredientsText: "PEANUTS, SUGAR",
        fetchedAt: new Date(),
        nutrients: [
          { nutrientId: 1008, name: "Energy", unit: "KCAL", amountPer100g: 500 },
          { nutrientId: 1109, name: "Vitamin E", unit: "MG", amountPer100g: 10 },
        ],
      },
      {
        fdcId: 11,
        description: "MILK",
        dataType: "Branded",
        ingredientsText: "MILK",
        fetchedAt: new Date(),
        nutrients: [{ nutrientId: 1087, name: "Calcium", unit: "MG", amountPer100g: 120 }],
      },
    ]);
    const { agent, user } = await member("mia");
    const { user: lee } = await member("lee");
    await UserAllergen.create([
      { userId: user._id, allergenId: peanut._id, mode: "avoid" },
      { userId: user._id, allergenId: milk._id, mode: "track", weeklyThreshold: 1 },
    ]);
    const log = (userId: Types.ObjectId, date: string, fdcId: number, grams: number) =>
      LogEntry.create({
        userId,
        date,
        meal: "lunch",
        fdcId,
        grams,
        source: "search",
        confidence: 1,
      });
    await log(user._id, TODAY, 10, 50);
    await log(user._id, "2026-11-14", 10, 50);
    await log(user._id, "2026-11-13", 11, 200);
    await log(user._id, "2026-11-12", 11, 200);
    await log(lee._id, TODAY, 11, 1000);

    const res = await agent.get("/api/users/me/summary").expect(200);
    const body = SummaryResponse.parse(res.body);
    expect(body).toMatchObject({
      weekEnding: TODAY,
      today: TODAY,
      loggedDays: 4,
      targetBasis: "reference",
      driSetKey: "reference-adult",
      calorieMeter: null,
      calorieMeterReason: "profile_incomplete",
    });
    expect(body.exposure).toEqual([
      {
        key: "milk",
        displayName: milk.displayName,
        tier: milk.tier,
        hits: 2,
        weight: 4,
        weeklyThreshold: 1,
        overThreshold: true,
        estimate: false,
      },
    ]);
    // Only today's peanut entry alerts, not the one two days ago; lee's milk never appears.
    expect(body.alerts).toEqual([
      {
        key: "peanuts",
        displayName: peanut.displayName,
        fdcId: 10,
        description: "PEANUT BAR",
        matchKind: "ingredient",
      },
    ]);
    // A week that ends before today still carries today's hard alert (eng review: alerts always use
    // today), while its bands and exposure cover only that week.
    const earlier = SummaryResponse.parse(
      (await agent.get("/api/users/me/summary?weekEnding=2026-11-12").expect(200)).body,
    );
    expect(earlier.alerts).toEqual(body.alerts);
    expect(earlier.loggedDays).toBe(1);
    const calcium = body.bands.find((b) => b.key === "calcium")!;
    expect(calcium.dataCoverage).toBeCloseTo(400 / 500, 5);
    expect(calcium.intakePerDay).toBeCloseTo(480 / 4, 5);

    // With a full profile the targets are personal and the meter appears.
    await MemberProfile.updateOne(
      { userId: user._id },
      {
        $set: {
          sex: "female",
          birthYear: 1990,
          heightCm: 165,
          weightKg: 60,
          activityLevel: "sedentary",
        },
      },
    );
    const personal = SummaryResponse.parse(
      (await agent.get("/api/users/me/summary").expect(200)).body,
    );
    expect(personal).toMatchObject({ targetBasis: "personal", driSetKey: "female-31-50" });
    expect(personal.calorieMeter).toEqual({
      kcal: 250,
      low: 1390,
      high: 1700,
      status: "under",
      basis: "computed",
    });

    // A past week still carries today's meter and today's alerts (they always use today).
    const past = SummaryResponse.parse(
      (await agent.get("/api/users/me/summary?weekEnding=2026-11-14").expect(200)).body,
    );
    expect(past.weekEnding).toBe("2026-11-14");
    expect(past.calorieMeter?.kcal).toBe(personal.calorieMeter?.kcal);
    expect(past.alerts).toEqual(personal.alerts);

    // The same food logged twice today is one alert, not two.
    await log(user._id, TODAY, 10, 20);
    const twice = SummaryResponse.parse(
      (await agent.get("/api/users/me/summary").expect(200)).body,
    );
    expect(twice.alerts).toHaveLength(1);
  });

  it("is 401 anonymous, 400 for a malformed or future week, and empty with no logs", async () => {
    await request(app).get("/api/users/me/summary").expect(401);
    const { agent } = await member("mia");
    await agent.get("/api/users/me/summary?weekEnding=yesterday").expect(400);
    await agent.get("/api/users/me/summary?weekEnding=2026-02-31").expect(400);
    const future = await agent.get("/api/users/me/summary?weekEnding=2026-11-17").expect(400);
    expect(future.body.error).toBe("date_in_future");
    const empty = SummaryResponse.parse(
      (await agent.get("/api/users/me/summary").expect(200)).body,
    );
    expect(empty.loggedDays).toBe(0);
    expect(empty.bands.every((b) => b.status === "empty")).toBe(true);
    expect(empty.exposure).toEqual([]);
  });

  // Attribution: added by the /ship test coverage audit (T25), pass 2.
  // Value: protects=exposure marks description-only hits as an estimate, a null threshold is never "over",
  //   a setting whose allergen was deleted is skipped, and a member with no profile row gets UTC + reference;
  //   fails_when=estimate is always false, null > n reads as over, a deleted allergen throws (500) or shows;
  //   why_new=the route test above has only ingredient hits, a set threshold and a profile; seam=none;
  //   no_claim=description keyword quality (seed dictionary on mongodb-memory-server)
  it("marks description-only exposure as an estimate and skips settings for a deleted allergen", async () => {
    await loadDictionary();
    const milk = (await Allergen.findOne({ key: "milk" }).lean())!;
    const peanut = (await Allergen.findOne({ key: "peanuts" }).lean())!;
    await Food.create({
      fdcId: 20,
      description: "Milk, whole",
      dataType: "Foundation",
      fetchedAt: new Date(),
      nutrients: [{ nutrientId: 1008, name: "Energy", unit: "KCAL", amountPer100g: 60 }],
    });
    const { agent, user } = await member("nia");
    await UserAllergen.create([
      { userId: user._id, allergenId: milk._id, mode: "track" },
      { userId: user._id, allergenId: peanut._id, mode: "avoid" },
    ]);
    await Allergen.deleteOne({ _id: peanut._id });
    await MemberProfile.deleteOne({ userId: user._id });
    await LogEntry.create({
      userId: user._id,
      date: TODAY,
      meal: "breakfast",
      fdcId: 20,
      grams: 250,
      source: "photo",
      confidence: 0.6,
    });
    const body = SummaryResponse.parse((await agent.get("/api/users/me/summary").expect(200)).body);
    expect(body).toMatchObject({ today: TODAY, targetBasis: "reference", calorieMeter: null });
    expect(body.exposure).toEqual([
      {
        key: "milk",
        displayName: milk.displayName,
        tier: milk.tier,
        hits: 1,
        weight: 2.5,
        weeklyThreshold: null,
        overThreshold: false,
        estimate: true,
      },
    ]);
    expect(body.alerts).toEqual([]);
    expect(body.days[6]).toEqual({ date: TODAY, logged: true, confidence: 0 });
  });

  // Generated for T15 (100% branches on summary.ts, eng review D13).
  // Value: protects=a log whose food has left the cache, or whose stored copy has no description or
  //   nutrients, still answers 200: the day counts as logged, it adds no nutrients and no exposure, and
  //   a stored avoid match still raises today's alert with a null description; fails_when=a missing
  //   food or field throws and the whole summary 500s, or a stored match is dropped; why_new=no test
  //   logged a food without a complete cached copy; seam=none; no_claim=how a copy loses its fields
  it("summarises logs whose food is gone from the cache or stored without fields", async () => {
    await loadDictionary();
    const milk = (await Allergen.findOne({ key: "milk" }).lean())!;
    const peanut = (await Allergen.findOne({ key: "peanuts" }).lean())!;
    // A stamped copy written without description or nutrients (insertOne skips the schema).
    await Food.collection.insertOne({
      fdcId: 31,
      dataType: "Foundation",
      fetchedAt: new Date(),
      allergensMatchedAt: new Date(),
    });
    await FoodAllergen.create({
      fdcId: 31,
      allergenId: peanut._id,
      matchKind: "ingredient",
      matchedSynonym: "peanut",
      matchedAt: new Date(),
    });
    const { agent, user } = await member("gone");
    await UserAllergen.create([
      { userId: user._id, allergenId: milk._id, mode: "track" },
      { userId: user._id, allergenId: peanut._id, mode: "avoid" },
    ]);
    const entry = (fdcId: number) => ({
      userId: user._id,
      date: TODAY,
      meal: "lunch" as const,
      fdcId,
      grams: 100,
      source: "search" as const,
      confidence: 1,
    });
    await LogEntry.create([entry(30), entry(31)]); // 30 has no cached copy at all
    const body = SummaryResponse.parse((await agent.get("/api/users/me/summary").expect(200)).body);
    expect(body.days[6]).toMatchObject({ date: TODAY, logged: true });
    expect(body.exposure).toEqual([
      expect.objectContaining({ key: "milk", hits: 0, estimate: false }),
    ]);
    expect(body.alerts).toEqual([
      expect.objectContaining({ key: "peanuts", fdcId: 31, description: null }),
    ]);
  });

  // Generated by /ship coverage audit (T15).
  // Value: protects=each tracked allergen's exposure uses that allergen's own match kind per entry, and a
  //   week mixing ingredient and description hits is not an estimate; fails_when=the T15 refactor pairs
  //   an entry with another allergen's kind, or estimate uses some() not every(); why_new=existing tests
  //   have one match kind per week and one allergen per food; seam=none; no_claim=how the matcher assigns
  //   kinds (FoodAllergen rows written directly on mongodb-memory-server)
  it("keeps each tracked allergen's own match kind when one food matches several", async () => {
    await loadDictionary();
    const milk = (await Allergen.findOne({ key: "milk" }).lean())!;
    const eggs = (await Allergen.findOne({ key: "eggs" }).lean())!;
    const stamped = (fdcId: number, description: string) => ({
      fdcId,
      description,
      dataType: "Branded",
      fetchedAt: new Date(),
      allergensMatchedAt: new Date(),
      nutrients: [],
    });
    await Food.create([stamped(40, "CUSTARD"), stamped(41, "LATTE")]);
    const row = (
      fdcId: number,
      allergenId: Types.ObjectId,
      matchKind: "description" | "ingredient",
    ) => ({
      fdcId,
      allergenId,
      matchKind,
      matchedSynonym: "x",
      matchedAt: new Date(),
    });
    await FoodAllergen.create([
      row(40, eggs._id, "description"),
      row(40, milk._id, "ingredient"),
      row(41, milk._id, "description"),
    ]);
    const { agent, user } = await member("kai");
    await UserAllergen.create([
      { userId: user._id, allergenId: milk._id, mode: "track" },
      { userId: user._id, allergenId: eggs._id, mode: "track" },
    ]);
    const entry = (fdcId: number, grams: number) => ({
      userId: user._id,
      date: TODAY,
      meal: "lunch" as const,
      fdcId,
      grams,
      source: "search" as const,
      confidence: 1,
    });
    await LogEntry.create([entry(40, 100), entry(41, 50)]);
    const body = SummaryResponse.parse((await agent.get("/api/users/me/summary").expect(200)).body);
    const byKey = new Map(body.exposure.map((x) => [x.key, x]));
    expect(byKey.get("milk")).toMatchObject({ hits: 2, weight: 1.5, estimate: false });
    expect(byKey.get("eggs")).toMatchObject({ hits: 1, weight: 1, estimate: true });
  });
});
