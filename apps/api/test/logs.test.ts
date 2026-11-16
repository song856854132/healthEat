import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { LogEntryCreated, LogEntryView, LogListResponse } from "@healtheat/shared";
import app from "../src/app.js";
import { Food, LogEntry, UserAllergen } from "../src/models/index.js";
import { todayIn } from "../src/services/logs.js";

// T6: me-scoped log routes with ownership guards, date rules, fetch-and-match and alerts (design doc
// REST table, A2, R3-25 to R3-27), plus the member's allergen settings the alerts read.

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/usda/${name}.json`, import.meta.url), "utf8"));
const CHEDDAR = fixture("food-branded-cheddar");
const CHOCOLATE = {
  ...CHEDDAR,
  fdcId: 999001,
  description: "DARK CHOCOLATE BAR",
  ingredients: "SUGAR, COCOA MASS, COCOA BUTTER, EMULSIFIER (SOY LECITHIN), VANILLA.",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async (url: string | URL) => {
    const id = Number(new URL(String(url)).pathname.split("/").pop());
    if (id === 2095236) return json(CHEDDAR);
    if (id === 999001) return json(CHOCOLATE);
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function member(username: string, timezone = "UTC") {
  const agent = request.agent(app);
  await agent
    .post("/api/auth/register")
    .send({
      username,
      email: `${username}@example.com`,
      password: "correct horse battery",
      timezone,
    })
    .expect(201);
  return agent;
}

const daysBefore = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const utcToday = () => todayIn("UTC");

describe("todayIn", () => {
  it("is the calendar date in the member's zone, and UTC for an unknown zone", () => {
    const now = new Date("2026-11-16T20:30:00Z");
    expect(todayIn("UTC", now)).toBe("2026-11-16");
    expect(todayIn("Pacific/Kiritimati", now)).toBe("2026-11-17"); // UTC+14
    expect(todayIn("America/Los_Angeles", now)).toBe("2026-11-16");
    expect(todayIn("Not/AZone", now)).toBe("2026-11-16");
  });
});

describe("POST /api/users/me/logs", () => {
  it("fetches and matches an uncached food, writes the entry for today, and returns no alerts without settings", async () => {
    const alice = await member("alice");
    const res = await alice
      .post("/api/users/me/logs")
      .send({ fdcId: 2095236, grams: 30, meal: "lunch" })
      .expect(201);
    const body = LogEntryCreated.parse(res.body);
    expect(body.entry).toMatchObject({
      date: utcToday(),
      meal: "lunch",
      fdcId: 2095236,
      description: "CHEDDAR CHEESE",
      grams: 30,
      source: "search",
      confidence: 1,
    });
    expect(body.alerts).toEqual([]);
    expect(await Food.countDocuments({ fdcId: 2095236 })).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns alerts for a backfilled entry whose food matches an avoided allergen (R3-26)", async () => {
    const alice = await member("alice");
    await alice
      .put("/api/users/me/allergens")
      .send({ allergens: [{ key: "soy" }] })
      .expect(200);
    const yesterday = daysBefore(utcToday(), 1);
    const res = await alice
      .post("/api/users/me/logs")
      .send({ fdcId: 999001, grams: 40, meal: "snack", date: yesterday })
      .expect(201);
    expect(res.body.entry.date).toBe(yesterday);
    expect(res.body.alerts).toEqual([
      {
        key: "soy",
        displayName: "Soy",
        tier: "both",
        matchKind: "ingredient",
        matchedSynonym: "soy lecithin",
      },
    ]);
  });

  it("does not alert for a tracked allergen, only for avoided ones", async () => {
    const alice = await member("alice");
    await alice
      .put("/api/users/me/allergens")
      .send({ allergens: [{ key: "soy", mode: "track", weeklyThreshold: 3 }, { key: "milk" }] })
      .expect(200);
    const choc = await alice
      .post("/api/users/me/logs")
      .send({ fdcId: 999001, grams: 40, meal: "snack" })
      .expect(201);
    expect(choc.body.alerts).toEqual([]);
    const cheese = await alice
      .post("/api/users/me/logs")
      .send({ fdcId: 2095236, grams: 30, meal: "lunch" })
      .expect(201);
    expect(cheese.body.alerts.map((a: { key: string }) => a.key)).toEqual(["milk"]);
  });

  it("refuses a date after today in the member's own time zone, and accepts that zone's today", async () => {
    const kiri = await member("kiri", "Pacific/Kiritimati");
    const today = todayIn("Pacific/Kiritimati");
    const tomorrow = daysBefore(today, -1);
    const res = await kiri
      .post("/api/users/me/logs")
      .send({ fdcId: 2095236, grams: 30, meal: "lunch", date: tomorrow })
      .expect(400);
    expect(res.body.error).toBe("date_in_future");
    await kiri
      .post("/api/users/me/logs")
      .send({ fdcId: 2095236, grams: 30, meal: "lunch", date: today })
      .expect(201);
    expect(await LogEntry.countDocuments()).toBe(1);
  });

  it("validates the body: impossible dates, grams out of range, unknown meals and extra fields are 400", async () => {
    const alice = await member("alice");
    for (const body of [
      { fdcId: 2095236, grams: 30, meal: "lunch", date: "2026-02-30" },
      { fdcId: 2095236, grams: 30, meal: "lunch", date: "16/11/2026" },
      { fdcId: 2095236, grams: 0, meal: "lunch" },
      { fdcId: 2095236, grams: 5001, meal: "lunch" },
      { fdcId: 2095236, grams: 30, meal: "brunch" },
      { fdcId: -1, grams: 30, meal: "lunch" },
      { fdcId: 2095236, grams: 30, meal: "lunch", source: "photo" },
    ])
      expect((await alice.post("/api/users/me/logs").send(body)).status, JSON.stringify(body)).toBe(
        400,
      );
    expect(await LogEntry.countDocuments()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes nothing when the food is unknown (404) or USDA is down with nothing cached (503)", async () => {
    const alice = await member("alice");
    const missing = await alice
      .post("/api/users/me/logs")
      .send({ fdcId: 123, grams: 30, meal: "lunch" })
      .expect(404);
    expect(missing.body.error).toBe("food_not_found");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock.mockImplementation(async () => json({}, 503));
    const down = await alice
      .post("/api/users/me/logs")
      .send({ fdcId: 2095236, grams: 30, meal: "lunch" })
      .expect(503);
    expect(down.body.error).toBe("usda_unavailable");
    expect(await LogEntry.countDocuments()).toBe(0);
  });

  it("needs a session", async () => {
    await request(app)
      .post("/api/users/me/logs")
      .send({ fdcId: 2095236, grams: 30, meal: "lunch" })
      .expect(401);
  });
});

describe("GET /api/users/me/logs", () => {
  it("lists only the caller's entries in the range, by date, meal and time, with the food's name", async () => {
    const alice = await member("alice");
    const bob = await member("bob");
    const today = utcToday();
    const yesterday = daysBefore(today, 1);
    const post = (agent: typeof alice, body: object) =>
      agent.post("/api/users/me/logs").send(body).expect(201);
    await post(alice, { fdcId: 2095236, grams: 30, meal: "dinner" });
    await post(alice, { fdcId: 999001, grams: 20, meal: "breakfast" });
    await post(alice, { fdcId: 2095236, grams: 10, meal: "lunch", date: yesterday });
    await post(bob, { fdcId: 2095236, grams: 99, meal: "lunch" });
    await post(alice, { fdcId: 2095236, grams: 5, meal: "lunch", date: daysBefore(today, 5) });

    const res = await alice.get(`/api/users/me/logs?from=${yesterday}&to=${today}`).expect(200);
    const body = LogListResponse.parse(res.body);
    expect(body.entries.map((e) => [e.date, e.meal, e.grams])).toEqual([
      [yesterday, "lunch", 10],
      [today, "breakfast", 20],
      [today, "dinner", 30],
    ]);
    expect(body.entries[1].description).toBe("DARK CHOCOLATE BAR");

    // No bounds: today only. One bound: that single day.
    const todayOnly = await alice.get("/api/users/me/logs").expect(200);
    expect(todayOnly.body).toMatchObject({ from: today, to: today });
    expect(todayOnly.body.entries).toHaveLength(2);
    const single = await alice.get(`/api/users/me/logs?from=${yesterday}`).expect(200);
    expect(single.body.entries).toHaveLength(1);
  });

  it("refuses an inverted or over-long range", async () => {
    const alice = await member("alice");
    await alice.get("/api/users/me/logs?from=2026-11-10&to=2026-11-01").expect(400);
    await alice.get("/api/users/me/logs?from=2026-01-01&to=2026-12-31").expect(400);
    await alice.get("/api/users/me/logs?from=2026-08-17&to=2026-11-16").expect(200); // 92 days
  });
});

describe("PUT and DELETE /api/logs/:id (ownership, A2)", () => {
  async function aliceWithEntry() {
    const alice = await member("alice");
    const res = await alice
      .post("/api/users/me/logs")
      .send({ fdcId: 2095236, grams: 30, meal: "lunch" })
      .expect(201);
    return { alice, id: res.body.entry.id as string, date: res.body.entry.date as string };
  }

  it("answers 403 for another member's entry and leaves it unchanged", async () => {
    const { id } = await aliceWithEntry();
    const bob = await member("bob");
    const put = await bob.put(`/api/logs/${id}`).send({ grams: 1 }).expect(403);
    expect(put.body.error).toBe("forbidden");
    await bob.delete(`/api/logs/${id}`).expect(403);
    expect((await LogEntry.findById(id).lean())?.grams).toBe(30);
  });

  it("answers 404 for an unknown or malformed id and 401 without a session", async () => {
    const { alice, id } = await aliceWithEntry();
    await alice.put("/api/logs/0123456789abcdef01234567").send({ grams: 1 }).expect(404);
    await alice.delete("/api/logs/not-an-id").expect(404);
    await request(app).put(`/api/logs/${id}`).send({ grams: 1 }).expect(401);
  });

  it("edits grams and meal only; the date and the food stay fixed (R3-27)", async () => {
    const { alice, id, date } = await aliceWithEntry();
    const res = await alice.put(`/api/logs/${id}`).send({ grams: 45, meal: "dinner" }).expect(200);
    expect(LogEntryView.parse(res.body)).toMatchObject({ id, grams: 45, meal: "dinner", date });
    for (const body of [
      { date: daysBefore(date, 1) },
      { fdcId: 999001 },
      { grams: 10, date: date },
      {},
      { grams: -3 },
    ])
      expect((await alice.put(`/api/logs/${id}`).send(body)).status, JSON.stringify(body)).toBe(
        400,
      );
    expect(await LogEntry.findById(id).lean()).toMatchObject({ grams: 45, meal: "dinner", date });
  });

  it("deletes the caller's own entry", async () => {
    const { alice, id } = await aliceWithEntry();
    await alice.delete(`/api/logs/${id}`).expect(204);
    expect(await LogEntry.countDocuments()).toBe(0);
    await alice.delete(`/api/logs/${id}`).expect(404);
  });
});

describe("GET and PUT /api/users/me/allergens", () => {
  it("replaces the list, defaults the mode from the tier, and lists by name", async () => {
    const alice = await member("alice");
    expect((await alice.get("/api/users/me/allergens").expect(200)).body).toEqual({
      allergens: [],
    });
    const res = await alice
      .put("/api/users/me/allergens")
      .send({ allergens: [{ key: "peanuts" }, { key: "lactose", weeklyThreshold: 4 }] })
      .expect(200);
    expect(res.body.allergens).toEqual([
      { key: "lactose", displayName: "Lactose", mode: "track", weeklyThreshold: 4 },
      { key: "peanuts", displayName: "Peanuts", mode: "avoid", weeklyThreshold: null },
    ]);
    // The next PUT replaces the list: peanuts dropped, lactose switched to avoid.
    await alice
      .put("/api/users/me/allergens")
      .send({ allergens: [{ key: "lactose", mode: "avoid" }] })
      .expect(200);
    const after = await alice.get("/api/users/me/allergens").expect(200);
    expect(after.body.allergens).toEqual([
      { key: "lactose", displayName: "Lactose", mode: "avoid", weeklyThreshold: null },
    ]);
    expect(await UserAllergen.countDocuments()).toBe(1);
  });

  it("refuses unknown keys, duplicates and a threshold on an avoided allergen, writing nothing", async () => {
    const alice = await member("alice");
    const unknown = await alice
      .put("/api/users/me/allergens")
      .send({ allergens: [{ key: "soy" }, { key: "kryptonite" }] })
      .expect(400);
    expect(unknown.body).toMatchObject({
      error: "unknown_allergen",
      details: { keys: ["kryptonite"] },
    });
    await alice
      .put("/api/users/me/allergens")
      .send({ allergens: [{ key: "soy" }, { key: "soy" }] })
      .expect(400);
    await alice
      .put("/api/users/me/allergens")
      .send({ allergens: [{ key: "soy", mode: "avoid", weeklyThreshold: 2 }] })
      .expect(400);
    expect(await UserAllergen.countDocuments()).toBe(0);
  });

  it("keeps one member's settings away from another", async () => {
    const alice = await member("alice");
    const bob = await member("bob");
    await alice
      .put("/api/users/me/allergens")
      .send({ allergens: [{ key: "soy" }] })
      .expect(200);
    expect((await bob.get("/api/users/me/allergens").expect(200)).body.allergens).toEqual([]);
    await bob.put("/api/users/me/allergens").send({ allergens: [] }).expect(200);
    expect((await alice.get("/api/users/me/allergens").expect(200)).body.allergens).toHaveLength(1);
  });
});

describe("indexes", () => {
  it("indexes LogEntry by member and date, by date, and UserAllergen once per member and allergen", async () => {
    await LogEntry.syncIndexes();
    await UserAllergen.syncIndexes();
    const logIdx = await LogEntry.collection.indexes();
    expect(logIdx).toContainEqual(expect.objectContaining({ key: { userId: 1, date: 1 } }));
    expect(logIdx).toContainEqual(expect.objectContaining({ key: { date: 1 } }));
    expect(await UserAllergen.collection.indexes()).toContainEqual(
      expect.objectContaining({ key: { userId: 1, allergenId: 1 }, unique: true }),
    );
  });
});
