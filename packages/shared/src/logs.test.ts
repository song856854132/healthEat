import { describe, expect, it } from "vitest";
import {
  LogDate,
  LogEntryCreateInput,
  LogEntryUpdateInput,
  LogsQuery,
  MAX_LOG_GRAMS,
  UserAllergensInput,
} from "./index.js";

describe("log schemas (T6)", () => {
  it("accepts real calendar dates only", () => {
    expect(LogDate.safeParse("2028-02-29").success).toBe(true);
    for (const bad of ["2026-02-29", "2026-13-01", "2026-1-01", "2026-11-16T00:00:00Z", ""])
      expect(LogDate.safeParse(bad).success, bad).toBe(false);
  });

  it("bounds grams and refuses unknown fields on create", () => {
    const ok = { fdcId: 1, grams: 1, meal: "snack" };
    expect(LogEntryCreateInput.parse(ok)).toEqual(ok);
    expect(LogEntryCreateInput.safeParse({ ...ok, grams: MAX_LOG_GRAMS + 1 }).success).toBe(false);
    expect(LogEntryCreateInput.safeParse({ ...ok, userId: "x" }).success).toBe(false);
    const requestId = "6f1c2b9e-3d4a-4f5b-9c8d-7e6f5a4b3c2d";
    expect(LogEntryCreateInput.parse({ ...ok, requestId })).toEqual({ ...ok, requestId });
    expect(LogEntryCreateInput.safeParse({ ...ok, requestId: "tap-1" }).success).toBe(false);
  });

  it("a photo item carries its confidence and batch; neither goes with a searched food (T13)", () => {
    const ok = { fdcId: 1, grams: 1, meal: "snack" };
    const photoBatchId = "0b7d2c4e-1f3a-4b5c-8d9e-0a1b2c3d4e5f";
    const photo = { ...ok, source: "photo", confidence: 0.6, photoBatchId };
    expect(LogEntryCreateInput.parse(photo)).toEqual(photo);
    expect(LogEntryCreateInput.parse({ ...ok, source: "search" })).toEqual({
      ...ok,
      source: "search",
    });
    for (const bad of [
      { ...ok, source: "photo" }, // a photo item without its confidence
      { ...ok, confidence: 0.6 }, // a confidence without the photo source
      { ...ok, source: "search", confidence: 1 },
      { ...ok, source: "photo", confidence: 1.5 },
      { ...ok, source: "camera", confidence: 0.5 },
      { ...ok, photoBatchId }, // a batch without the photo source
      { ...ok, source: "photo", confidence: 0.6, photoBatchId: "batch-1" },
    ])
      expect(LogEntryCreateInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("edits grams and meal only, and at least one of them", () => {
    expect(LogEntryUpdateInput.safeParse({ meal: "lunch" }).success).toBe(true);
    expect(LogEntryUpdateInput.safeParse({}).success).toBe(false);
    expect(LogEntryUpdateInput.safeParse({ grams: 5, date: "2026-11-01" }).success).toBe(false);
  });

  it("caps the log range at 92 days and keeps from before to", () => {
    expect(LogsQuery.safeParse({ from: "2026-08-17", to: "2026-11-16" }).success).toBe(true);
    expect(LogsQuery.safeParse({ from: "2026-08-16", to: "2026-11-16" }).success).toBe(false);
    expect(LogsQuery.safeParse({ from: "2026-11-02", to: "2026-11-01" }).success).toBe(false);
  });

  it("allergen settings: each key once, threshold only for track mode", () => {
    expect(UserAllergensInput.safeParse({ allergens: [{ key: "soy" }] }).success).toBe(true);
    expect(
      UserAllergensInput.safeParse({ allergens: [{ key: "soy" }, { key: "soy" }] }).success,
    ).toBe(false);
    expect(
      UserAllergensInput.safeParse({
        allergens: [{ key: "soy", mode: "avoid", weeklyThreshold: 2 }],
      }).success,
    ).toBe(false);
    expect(
      UserAllergensInput.safeParse({ allergens: [{ key: "soy", weeklyThreshold: 2 }] }).success,
    ).toBe(true);
  });
});
