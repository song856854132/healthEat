import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../src/app.js";
import { Allergen, LogEntry, User } from "../src/models/index.js";
import { loadDictionary } from "../src/services/dictionary.js";

// T16: every role guard answers 403 to a signed-in account without the role, and the refused request
// writes nothing (design doc D18, Roles; requireRole checks `roles`, never `activeRole`).

type Agent = ReturnType<typeof request.agent>;
type Call = { name: string; send: (agent: Agent) => request.Test };

async function signIn(username: string) {
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

describe("role guards", () => {
  // Value: protects=a plain member gets 403 forbidden from every Curator and Admin route, and the
  //   refused write leaves the dictionary and the accounts unchanged; fails_when=a router loses its
  //   requireRole or the guard runs after the handler; why_new=T16 audit (only some routes had a
  //   403 test); seam=none; no_claim=what each route does for an allowed role (its own tests)
  it("refuses every Curator and Admin route to a member-only account", async () => {
    await loadDictionary();
    const allergenId = String((await Allergen.findOne().lean())!._id);
    const { agent } = await signIn("plainmember");
    const { user: target } = await signIn("someoneelse");
    const allergensBefore = await Allergen.countDocuments();

    const calls: Call[] = [
      { name: "POST /api/allergens", send: (a) => a.post("/api/allergens").send({}) },
      {
        name: "PUT /api/allergens/:id",
        send: (a) => a.put(`/api/allergens/${allergenId}`).send({}),
      },
      { name: "DELETE /api/allergens/:id", send: (a) => a.delete(`/api/allergens/${allergenId}`) },
      {
        name: "POST /api/curate/allergens/:id/rematch",
        send: (a) => a.post(`/api/curate/allergens/${allergenId}/rematch`),
      },
      { name: "GET /api/curate/unmatched", send: (a) => a.get("/api/curate/unmatched") },
      {
        name: "PUT /api/curate/unmatched/:token",
        send: (a) => a.put("/api/curate/unmatched/xanthan%20gum").send({ action: "ignore" }),
      },
      { name: "GET /api/admin/users", send: (a) => a.get("/api/admin/users") },
      {
        name: "GET /api/admin/users/:username",
        send: (a) => a.get("/api/admin/users/someoneelse"),
      },
      {
        name: "PUT /api/admin/users/:username/roles",
        send: (a) =>
          a.put("/api/admin/users/someoneelse/roles").send({ roles: ["member", "admin"] }),
      },
      {
        name: "PUT /api/admin/users/:username/status",
        send: (a) => a.put("/api/admin/users/someoneelse/status").send({ status: "suspended" }),
      },
      {
        name: "DELETE /api/admin/users/:username",
        send: (a) => a.delete("/api/admin/users/someoneelse"),
      },
    ];
    for (const call of calls) {
      const res = await call.send(agent);
      expect({ route: call.name, status: res.status, error: res.body.error }).toEqual({
        route: call.name,
        status: 403,
        error: "forbidden",
      });
    }

    expect(await Allergen.countDocuments()).toBe(allergensBefore);
    expect(await Allergen.findById(allergenId)).not.toBeNull();
    const after = (await User.findById(target._id).lean())!;
    expect(after).toMatchObject({ roles: ["member"], status: "active", deletionPending: false });
  });

  // Value: protects=the member guard refuses an account stored without the member role (the schema
  //   forbids it, so this is the guard's own line of defence) on every member route, writing no log;
  //   fails_when=member routes drop requireRole("member"); why_new=T16 audit; seam=none;
  //   no_claim=how such an account could arise
  it("refuses every member route to an account without the member role", async () => {
    const { agent, user } = await signIn("staffonly");
    // updateOne skips the roles validator, which would refuse this shape.
    await User.updateOne(
      { _id: user._id },
      { $set: { roles: ["curator"], activeRole: "curator" } },
    );

    const calls: Call[] = [
      { name: "GET /api/users/me/logs", send: (a) => a.get("/api/users/me/logs") },
      {
        name: "POST /api/users/me/logs",
        send: (a) =>
          a.post("/api/users/me/logs").send({ fdcId: 2095236, grams: 30, meal: "lunch" }),
      },
      { name: "GET /api/users/me/allergens", send: (a) => a.get("/api/users/me/allergens") },
      {
        name: "PUT /api/users/me/allergens",
        send: (a) => a.put("/api/users/me/allergens").send({ allergens: [] }),
      },
      { name: "GET /api/users/me/summary", send: (a) => a.get("/api/users/me/summary") },
    ];
    for (const call of calls) {
      const res = await call.send(agent);
      expect({ route: call.name, status: res.status, error: res.body.error }).toEqual({
        route: call.name,
        status: 403,
        error: "forbidden",
      });
    }
    expect(await LogEntry.countDocuments({ userId: user._id })).toBe(0);
  });

  // Value: protects=a member cannot edit or delete another member's log entry, whatever roles they
  //   hold (D18: staff never touch member logs), and the entry is unchanged; fails_when=requireOwner
  //   is dropped or lets curators or admins through; why_new=T16 audit; seam=none; no_claim=none
  it("refuses another account's log entry to any role, leaving it unchanged", async () => {
    const { user: owner } = await signIn("logowner");
    const entry = await LogEntry.create({
      userId: owner._id,
      date: "2026-11-16",
      meal: "lunch",
      fdcId: 2095236,
      grams: 30,
      source: "search",
      confidence: 1,
    });
    const { agent, user: other } = await signIn("bigstaff");
    const staff = (await User.findById(other._id))!;
    staff.roles = ["member", "curator", "admin"];
    await staff.save();

    for (const res of [
      await agent.put(`/api/logs/${entry._id}`).send({ grams: 99 }),
      await agent.delete(`/api/logs/${entry._id}`),
    ]) {
      expect({ status: res.status, error: res.body.error }).toEqual({
        status: 403,
        error: "forbidden",
      });
    }
    expect((await LogEntry.findById(entry._id).lean())?.grams).toBe(30);
  });
});
