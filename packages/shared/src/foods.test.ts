import { describe, expect, it } from "vitest";
import { FOOD_SEARCH_MAX_PAGE, FdcIdParam, FoodSearchQuery } from "./index.js";

describe("FoodSearchQuery", () => {
  it("collapses whitespace, defaults the page and coerces it from the query string", () => {
    expect(FoodSearchQuery.parse({ q: "  cheddar   cheese " })).toEqual({
      q: "cheddar cheese",
      page: 1,
    });
    expect(FoodSearchQuery.parse({ q: "apple", page: "3", dataType: "SR Legacy" })).toEqual({
      q: "apple",
      page: 3,
      dataType: "SR Legacy",
    });
  });
  it("rejects a blank query, a page outside 1..max and an unknown data type", () => {
    expect(FoodSearchQuery.safeParse({ q: "   " }).success).toBe(false);
    expect(FoodSearchQuery.safeParse({ q: "a", page: "0" }).success).toBe(false);
    expect(
      FoodSearchQuery.safeParse({ q: "a", page: String(FOOD_SEARCH_MAX_PAGE + 1) }).success,
    ).toBe(false);
    expect(FoodSearchQuery.safeParse({ q: "a", dataType: "branded" }).success).toBe(false);
    expect(FoodSearchQuery.safeParse({ q: "x".repeat(201) }).success).toBe(false);
  });
});

describe("FdcIdParam", () => {
  it("accepts positive integers only", () => {
    expect(FdcIdParam.parse("1750340")).toBe(1750340);
    for (const bad of ["0", "-1", "1.5", "abc", ""])
      expect(FdcIdParam.safeParse(bad).success).toBe(false);
  });
});
