import { describe, expect, it } from "vitest";
import {
  AdminProfileInput,
  AdminUsersQuery,
  AllergenUpdateInput,
  CuratorProfileInput,
  EditableProfileKind,
} from "./index.js";

describe("AdminUsersQuery", () => {
  it("coerces the page, lowercases q and refuses unknown roles", () => {
    expect(AdminUsersQuery.parse({ q: "  Ada ", page: "3" })).toEqual({ q: "ada", page: 3 });
    expect(AdminUsersQuery.parse({})).toEqual({ page: 1 });
    expect(AdminUsersQuery.safeParse({ role: "coach" }).success).toBe(false);
    expect(AdminUsersQuery.safeParse({ page: "0" }).success).toBe(false);
  });
});

describe("profile inputs", () => {
  it("accept only the fields a caller may edit, never the server-written counters", () => {
    expect(CuratorProfileInput.parse({ bio: " hi ", credentials: null })).toEqual({
      bio: "hi",
      credentials: null,
    });
    expect(CuratorProfileInput.safeParse({ editsCount: 3 }).success).toBe(false);
    expect(CuratorProfileInput.safeParse({ specialties: ["FODMAP", "fodmap"] }).success).toBe(
      false,
    );
    expect(AdminProfileInput.safeParse({ grantsCount: 1 }).success).toBe(false);
    expect(EditableProfileKind.safeParse("member").success).toBe(true); // editable since T27
    expect(EditableProfileKind.safeParse("coach").success).toBe(false);
  });
});

describe("AllergenUpdateInput", () => {
  it("refuses a key: the key is the entry's stable identifier", () => {
    const body = {
      displayName: "Sesame",
      tier: "allergy",
      synonyms: ["sesame"],
      descriptionKeywords: [],
      excludePhrases: [],
    };
    expect(AllergenUpdateInput.safeParse(body).success).toBe(true);
    expect(AllergenUpdateInput.safeParse({ ...body, key: "sesame" }).success).toBe(false);
  });
});
