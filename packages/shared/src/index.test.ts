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
      now: new Date().toISOString(),
    });
    expect(parsed.ok).toBe(true);
  });
  it("rejects ok=false", () => {
    expect(() => HealthResponse.parse({ ok: false })).toThrow();
  });
  it("WhoAmI allows null", () => {
    expect(WhoAmI.parse({ name: null }).name).toBeNull();
  });
});
