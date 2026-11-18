import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import app from "../src/app.js";
import { CuratorProfile, MemberProfile, User } from "../src/models/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});
// T27: edit the account and the member profile; read a public profile (design doc REST table).

const PASSWORD = "correct horse battery";

async function make(username: string) {
  const agent = request.agent(app);
  await agent
    .post("/api/auth/register")
    .send({ username, email: `${username}@example.com`, password: PASSWORD, timezone: "UTC" })
    .expect(201);
  return { agent, user: (await User.findOne({ username }))! };
}

describe("PUT /api/users/me", () => {
  // Value: protects=the username never changes and the email edit persists; fails_when=the route accepts
  //   a username or drops the email write; why_new=no account edit existed; seam=none; no_claim=email
  //   ownership verification (none in the stack)
  it("changes the email, refuses a username change and a taken email", async () => {
    const { agent } = await make("mia");
    await make("lee");
    const res = await agent.put("/api/users/me").send({ email: "Mia.New@Example.com" }).expect(200);
    expect(res.body.user).toMatchObject({ username: "mia", email: "mia.new@example.com" });
    const refused = await agent
      .put("/api/users/me")
      .send({ username: "mia2", email: "x@example.com" })
      .expect(400);
    expect(refused.body.error).toBe("username_immutable");
    await agent.put("/api/users/me").send({ email: "lee@example.com" }).expect(409);
    await agent.put("/api/users/me").send({ email: "not an email" }).expect(400);
    // Value (ship audit extension): protects=the email body is strict and required, and re-saving one's own
    //   email is not a conflict; fails_when=.strict() or the required email is dropped, or a taken-email
    //   pre-check forgets to exclude the caller; why_new=rows above cover only bad and taken emails;
    //   seam=none; no_claim=none beyond protects
    await agent.put("/api/users/me").send({}).expect(400);
    await agent
      .put("/api/users/me")
      .send({ email: "a@example.com", roles: ["admin"] })
      .expect(400);
    await agent.put("/api/users/me").send({ email: "mia.new@example.com" }).expect(200);
    await request(app).put("/api/users/me").send({ email: "a@example.com" }).expect(401);
    expect((await User.findOne({ username: "mia" }).lean())?.email).toBe("mia.new@example.com");
  });
});

describe("GET and PUT /api/users/me/profiles/member", () => {
  // Value: protects=a member edits body metrics, band, timezone and opt-ins, clears optional fields with
  //   null, and cannot clear the defaulted fields; fails_when=null timezone or sex is unset, or the band
  //   accepts low > high; why_new=member profile was not editable (answered 400); seam=none;
  //   no_claim=how the summary uses these fields (T25)
  it("reads defaults, edits fields, clears optional ones and refuses clearing required ones", async () => {
    const { agent, user } = await make("mia");
    const empty = await agent.get("/api/users/me/profiles/member").expect(200);
    expect(empty.body).toEqual({
      kind: "member",
      sex: "unspecified",
      birthYear: null,
      heightCm: null,
      weightKg: null,
      activityLevel: "light",
      calorieBand: null,
      timezone: "UTC",
      publicLogs: false,
      showPhoneOnProfile: false,
      phone: null,
    });
    const res = await agent
      .put("/api/users/me/profiles/member")
      .send({
        sex: "female",
        birthYear: 1990,
        heightCm: 165,
        weightKg: 60,
        activityLevel: "moderate",
        calorieBand: { low: 1800, high: 2200 },
        timezone: "asia/taipei",
        publicLogs: true,
        phone: "+1 555 0100",
      })
      .expect(200);
    expect(res.body).toMatchObject({
      sex: "female",
      birthYear: 1990,
      calorieBand: { low: 1800, high: 2200 },
      timezone: "Asia/Taipei",
      publicLogs: true,
      phone: "+1 555 0100",
    });
    const cleared = await agent
      .put("/api/users/me/profiles/member")
      .send({ calorieBand: null, phone: "" })
      .expect(200);
    expect(cleared.body).toMatchObject({ calorieBand: null, phone: null, birthYear: 1990 });
    for (const bad of [
      { timezone: null },
      { timezone: "Mars/Olympus" },
      { sex: null },
      { activityLevel: null },
      { calorieBand: { low: 2500, high: 2000 } },
      { birthYear: new Date().getUTCFullYear() + 1 },
      { heightCm: 10 },
      { visionUsage: { count: 0 } },
      { driSetKey: "f19" },
      { phone: "call me" },
    ])
      await agent.put("/api/users/me/profiles/member").send(bad).expect(400);
    const stored = (await MemberProfile.findOne({ userId: user._id }).lean())!;
    expect(stored.timezone).toBe("Asia/Taipei");
    expect(stored.sex).toBe("female");
  });
});

describe("member profile missing", () => {
  // Generated by /ship test coverage audit (T27).
  // Value: protects=an account with no MemberProfile document reads schema defaults, gets a public
  //   profile, and creates the document on its first edit; fails_when=memberView or publicProfile
  //   dereferences a null profile (500), or the member upsert is dropped; why_new=every other test
  //   registers, which always creates the document; seam=none; no_claim=how a profile goes missing
  //   (simulated by deleting it)
  it("reads defaults, serves the public profile and upserts on the first edit", async () => {
    const { agent, user } = await make("mia");
    await MemberProfile.deleteOne({ userId: user._id });
    const empty = await agent.get("/api/users/me/profiles/member").expect(200);
    expect(empty.body).toMatchObject({
      kind: "member",
      timezone: "UTC",
      calorieBand: null,
      phone: null,
    });
    const pub = await agent.get("/api/users/mia").expect(200);
    expect(pub.body.phone).toBeNull();
    expect(pub.body.private.member).toMatchObject({ sex: "unspecified", activityLevel: "light" });
    await agent.put("/api/users/me/profiles/member").send({ heightCm: 170 }).expect(200);
    const stored = (await MemberProfile.findOne({ userId: user._id }).lean())!;
    expect(stored).toMatchObject({ heightCm: 170, timezone: "UTC" });
  });
});

describe("GET /api/users/:username", () => {
  // Value: protects=a public profile shows only public fields to others and the private block only to
  //   the account itself; phone only when opted in; blocked accounts 404; fails_when=email or body
  //   metrics leak to another viewer, or a suspended account stays visible; why_new=no public profile
  //   route existed; seam=none; no_claim=web rendering of the profile page (lane B)
  it("shows public fields to anyone, private fields only to self, and hides blocked accounts", async () => {
    const { agent: mia } = await make("mia");
    const { agent: lee, user: leeUser } = await make("lee");
    await mia
      .put("/api/users/me/profiles/member")
      .send({ heightCm: 165, phone: "555-0199" })
      .expect(200);

    const anon = await request(app).get("/api/users/MIA").expect(200);
    expect(anon.body).toMatchObject({ username: "mia", roles: ["member"], self: false });
    expect(anon.body.private).toBeNull();
    expect(anon.body.phone).toBeNull(); // not opted in
    expect(anon.body.curator).toBeNull();
    expect(JSON.stringify(anon.body)).not.toContain("mia@example.com");

    const other = await lee.get("/api/users/mia").expect(200);
    expect(other.body.private).toBeNull();
    expect(JSON.stringify(other.body)).not.toContain("165");

    const self = await mia.get("/api/users/mia").expect(200);
    expect(self.body.self).toBe(true);
    expect(self.body.private).toMatchObject({
      email: "mia@example.com",
      member: { heightCm: 165, phone: "555-0199" },
    });

    await mia.put("/api/users/me/profiles/member").send({ showPhoneOnProfile: true }).expect(200);
    expect((await request(app).get("/api/users/mia").expect(200)).body.phone).toBe("555-0199");

    await User.updateOne({ _id: leeUser._id }, { $set: { roles: ["member", "curator"] } });
    await CuratorProfile.create({
      userId: leeUser._id,
      bio: "Dairy-free cook",
      specialties: ["dairy"],
    });
    expect((await request(app).get("/api/users/lee").expect(200)).body.curator).toEqual({
      credentials: null,
      bio: "Dairy-free cook",
      specialties: ["dairy"],
    });

    await User.updateOne({ _id: leeUser._id }, { $set: { status: "suspended" } });
    await request(app).get("/api/users/lee").expect(404);
    await User.updateOne(
      { _id: leeUser._id },
      { $set: { status: "active", deletionPending: true } },
    );
    await request(app).get("/api/users/lee").expect(404);
    await request(app).get("/api/users/nobody").expect(404);
    await request(app).get("/api/users/x!").expect(404);
  });
});
