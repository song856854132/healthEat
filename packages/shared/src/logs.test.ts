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
