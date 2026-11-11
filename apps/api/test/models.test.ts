import { describe, expect, it } from "vitest";
import { AdminProfile, CuratorProfile, MemberProfile, User } from "../src/models/index.js";
import { toHttpResponse } from "../src/middleware/error.js";

const base = { email: "hungju@example.com", passwordHash: "x".repeat(60), username: "hungju" };

describe("User model", () => {
  it("defaults: member role, active, member view, no privacy ack", async () => {
    const u = await User.create(base);
    expect(u.roles).toEqual(["member"]);
    expect(u.status).toBe("active");
    expect(u.activeRole).toBe("member");
    expect(u.privacyAckAt).toBeUndefined();
    expect(u.deletionPending).toBe(false);
  });

  it("username is immutable after creation (rubric)", async () => {
    const u = await User.create(base);
    u.username = "someone_else";
    await u.save();
    const again = await User.findById(u._id).lean();
    expect(again?.username).toBe("hungju");
  });

  it("username and email are unique; the violation maps to 409", async () => {
    await User.init();
    await User.create(base);
    let err: unknown;
    try {
      await User.create({ ...base, email: "other@example.com" });
    } catch (e) {
      err = e;
    }
    expect(toHttpResponse(err).status).toBe(409);
    err = undefined;
    try {
      await User.create({ ...base, username: "another" });
    } catch (e) {
      err = e;
    }
    expect(err, "duplicate email must be rejected").toBeTruthy();
    expect(toHttpResponse(err).status).toBe(409);
  });

  // Value: protects=a document that fails Mongoose validation reaches the client as
  //   400 validation_error naming the field (not a 500), and valid input is normalised to lowercase;
  //   fails_when=the username pattern or lowercase option is removed, or the error middleware stops
  //   recognising Mongoose's ValidationError by name; why_new=the earlier assertion stopped at the
  //   error's name and never ran it through the response mapping; seam=none; no_claim=does not
  //   enumerate every field rule of the four models
  it("rejects usernames outside [a-z0-9_]{3,24} as 400 validation_error and lowercases input", async () => {
    const err: unknown = await User.create({ ...base, username: "ab" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ name: "ValidationError" });
    const mapped = toHttpResponse(err);
    expect(mapped.status).toBe(400);
    expect(mapped.body.error).toBe("validation_error");
    expect(String(mapped.body.details)).toMatch(/username/);
    const u = await User.create({ ...base, username: "MixedCase_1" });
    expect(u.username).toBe("mixedcase_1");
  });

  it("passwordHash is not selected by default", async () => {
    await User.create(base);
    const found = await User.findOne({ username: "hungju" });
    expect(found?.passwordHash).toBeUndefined();
    const withHash = await User.findOne({ username: "hungju" }).select("+passwordHash");
    expect(withHash?.passwordHash).toHaveLength(60);
  });

  it("roles must include member", async () => {
    await expect(User.create({ ...base, roles: ["admin"] })).rejects.toMatchObject({
      name: "ValidationError",
    });
  });
});

describe("profiles", () => {
  it("one profile per user per kind (unique userId)", async () => {
    const u = await User.create(base);
    await Promise.all([MemberProfile.init(), CuratorProfile.init(), AdminProfile.init()]);
    await MemberProfile.create({ userId: u._id, timezone: "Asia/Taipei" });
    await expect(MemberProfile.create({ userId: u._id })).rejects.toMatchObject({ code: 11000 });
    const c = await CuratorProfile.create({ userId: u._id });
    expect(c.editsCount).toBe(0);
    const a = await AdminProfile.create({ userId: u._id });
    expect(a.grantsCount).toBe(0);
  });

  it("declares the indexes the plan requires", async () => {
    await Promise.all([User.init(), MemberProfile.init()]);
    const userIdx = await User.collection.indexes();
    const names = userIdx.map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(["username_1", "email_1"]));
    expect(userIdx.find((i) => i.name === "username_1")?.unique).toBe(true);
    const memberIdx = await MemberProfile.collection.indexes();
    expect(memberIdx.find((i) => i.name === "userId_1")?.unique).toBe(true);
  });
});

describe("User.activeRole", () => {
  it("must be one of the held roles", async () => {
    await expect(
      User.create({ ...base, roles: ["member"], activeRole: "admin" }),
    ).rejects.toMatchObject({
      name: "ValidationError",
    });
    const u = await User.create({ ...base, roles: ["member", "curator"], activeRole: "curator" });
    expect(u.activeRole).toBe("curator");
  });
  it("a malformed id maps to 400 invalid_id", async () => {
    let err: unknown;
    try {
      await User.findById("not-an-object-id");
    } catch (e) {
      err = e;
    }
    expect(toHttpResponse(err)).toEqual({ status: 400, body: { error: "invalid_id" } });
  });
});

describe("enum and bounds validation", () => {
  it("rejects a role outside member|curator|admin (the coach role was removed at D18)", async () => {
    await expect(
      User.create({ ...base, roles: ["member", "coach"] as never }),
    ).rejects.toMatchObject({
      name: "ValidationError",
    });
  });
  it("rejects out-of-range body metrics on MemberProfile", async () => {
    const u = await User.create(base);
    await expect(MemberProfile.create({ userId: u._id, heightCm: 500 })).rejects.toMatchObject({
      name: "ValidationError",
    });
    await expect(
      MemberProfile.create({ userId: u._id, activityLevel: "couch" as never }),
    ).rejects.toMatchObject({
      name: "ValidationError",
    });
  });
});
