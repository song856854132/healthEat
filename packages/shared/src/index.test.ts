import { describe, expect, it } from "vitest";
import { HealthResponse, WhoAmI } from "./index";

describe("HealthResponse", () => {
  it("accepts a well-formed payload", () => {
    const parsed = HealthResponse.parse({
      ok: true,
      service: "healtheat-api",
      version: "0.1.0",
      commit: "abc123",
      env: "local",
      db: "connected",
      dbName: "healtheat_test",
      secrets: "ok",
      now: new Date().toISOString(),
    });
    expect(parsed.ok).toBe(true);
  });
  it("rejects a payload without dbName", () => {
    expect(() =>
      HealthResponse.parse({
        ok: true,
        service: "healtheat-api",
        version: "0",
        commit: "c",
        env: "local",
        db: "connected",
        secrets: "ok",
        now: new Date().toISOString(),
      }),
    ).toThrow();
  });
  it("rejects ok=false", () => {
    expect(() => HealthResponse.parse({ ok: false })).toThrow();
  });
  it("WhoAmI allows null", () => {
    expect(WhoAmI.parse({ name: null }).name).toBeNull();
  });
});
