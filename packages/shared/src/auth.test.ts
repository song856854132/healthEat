import { describe, expect, it } from "vitest";
import {
  ActiveRoleInput,
  LoginInput,
  MeResponse,
  RoleUpdateInput,
  RegisterInput,
  USERNAME_PATTERN,
  canonicalTimeZone,
  isValidTimeZone,
} from "./index.js";

describe("RegisterInput", () => {
  it("normalises username and email and canonicalises the time zone", () => {
    const parsed = RegisterInput.parse({
      username: " Hung_Ju ",
      email: " Hung@Example.COM ",
      password: "correct horse battery",
      timezone: "utc",
    });
    expect(parsed).toEqual({
      username: "hung_ju",
      email: "hung@example.com",
      password: "correct horse battery",
      timezone: "UTC",
    });
  });
  it("rejects a bad username, a short password, a bad email and an unknown zone, naming each path", () => {
    const r = RegisterInput.safeParse({
      username: "ab",
      email: "nope",
      password: "short",
      timezone: "Mars/Olympus",
    });
    expect(r.success).toBe(false);
    const paths = r.error!.issues.map((i) => i.path.join("."));
    expect(paths).toEqual(["username", "email", "password", "timezone"]);
  });
  it("shares the username rule with the Mongoose schema", () => {
    expect(USERNAME_PATTERN.test("a_1")).toBe(true);
    expect(USERNAME_PATTERN.test("Upper")).toBe(false);
    expect(USERNAME_PATTERN.test("a".repeat(25))).toBe(false);
  });
});

describe("time zones", () => {
  it("accepts UTC and legacy aliases that Intl.supportedValuesOf omits", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Asia/Calcutta")).toBe(true);
    expect(isValidTimeZone("Asia/Taipei")).toBe(true);
    expect(isValidTimeZone("Nowhere/City")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(canonicalTimeZone("utc")).toBe("UTC");
    expect(canonicalTimeZone("asia/taipei")).toBe("Asia/Taipei");
  });
});

describe("LoginInput, ActiveRoleInput, MeResponse", () => {
  it("login lowercases the username without applying the pattern (same 401 either way)", () => {
    expect(LoginInput.parse({ username: " Who Ever ", password: "x" }).username).toBe("who ever");
    expect(LoginInput.safeParse({ username: "", password: "x" }).success).toBe(false);
  });
  it("active role must be one of the three roles (no coach, D18)", () => {
    expect(ActiveRoleInput.parse({ role: "curator" })).toEqual({ role: "curator" });
    expect(ActiveRoleInput.safeParse({ role: "coach" }).success).toBe(false);
  });
  it("MeResponse requires ISO dates and the three profile flags", () => {
    const ok = MeResponse.safeParse({
      user: {
        username: "hungju",
        email: "h@example.com",
        roles: ["member"],
        status: "active",
        activeRole: "member",
        privacyAckAt: null,
        createdAt: "2026-11-11T00:00:00.000Z",
      },
      profiles: { member: true, curator: false, admin: false },
    });
    expect(ok.success).toBe(true);
    expect(
      MeResponse.safeParse({ user: { username: "x" }, profiles: { member: true } }).success,
    ).toBe(false);
  });
});

describe("RoleUpdateInput", () => {
  it("requires member, rejects repeats and unknown roles", () => {
    expect(RoleUpdateInput.parse({ roles: ["member", "admin"] })).toEqual({
      roles: ["member", "admin"],
    });
    expect(RoleUpdateInput.safeParse({ roles: ["admin"] }).success).toBe(false);
    expect(RoleUpdateInput.safeParse({ roles: ["member", "member"] }).success).toBe(false);
    expect(RoleUpdateInput.safeParse({ roles: ["member", "coach"] }).success).toBe(false);
    expect(RoleUpdateInput.safeParse({ roles: [] }).success).toBe(false);
  });
});
