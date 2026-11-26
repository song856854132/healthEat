import type { Page } from "@playwright/test";
// From source, not "@healtheat/shared": the preview's Playwright job runs only `npm ci`, so the
// package's dist/ is not built there. Playwright compiles the TypeScript itself.
import {
  AdminProfileView,
  AllergenListResponse,
  CuratorProfileView,
  MeResponse,
  MemberProfileView,
} from "../packages/shared/src/index";
import type { Role } from "../packages/shared/src/index";

// T21: a Curator or Admin session for the e2e specs. Neither role can be had on a preview deployment
// from a spec (Admin comes only from the API's ADMIN_USERNAMES, and only an Admin grants Curator), so
// these specs answer GET /api/auth/me and the role routes from mocks. Every mock is parsed with the
// shared schema, so it cannot drift from the API contract. The role guards themselves are the API's
// tests (apps/api/test/roleGuards.test.ts); the specs that use a real account check what a member sees.

export type MockSession = {
  username: string;
  roles: Role[];
  activeRole: Role;
  /** Bodies sent to PUT /api/users/me/active-role, in order. */
  switches: { role: Role }[];
  /** When set, the next view switches answer this error instead. */
  failSwitch: { status: number; error: string } | null;
};

export function meFor(s: Pick<MockSession, "username" | "roles" | "activeRole">): MeResponse {
  return MeResponse.parse({
    user: {
      username: s.username,
      email: `${s.username}@example.com`,
      roles: s.roles,
      status: "active",
      activeRole: s.activeRole,
      // Acknowledged, so the privacy notice stays out of the way.
      privacyAckAt: "2026-11-01T00:00:00.000Z",
      createdAt: "2026-11-01T00:00:00.000Z",
    },
    profiles: {
      member: true,
      curator: s.roles.includes("curator"),
      admin: s.roles.includes("admin"),
    },
  });
}

/** Signs the tab in as a mocked account; PUT /api/users/me/active-role switches its view. */
export async function mockSession(
  page: Page,
  init: Pick<MockSession, "username" | "roles" | "activeRole">,
): Promise<MockSession> {
  const session: MockSession = { ...init, switches: [], failSwitch: null };
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: meFor(session) }));
  await page.route("**/api/users/me/active-role", (route) => {
    const body = route.request().postDataJSON() as { role: Role };
    session.switches.push(body);
    if (session.failSwitch)
      return route.fulfill({
        status: session.failSwitch.status,
        json: { error: session.failSwitch.error },
      });
    session.activeRole = body.role;
    return route.fulfill({ json: meFor(session) });
  });
  // The member profile, for /profile (every account is a member).
  await page.route("**/api/users/me/profiles/member", (route) =>
    route.fulfill({ json: MEMBER_PROFILE }),
  );
  return session;
}

export const MEMBER_PROFILE = MemberProfileView.parse({
  kind: "member",
  sex: "unspecified",
  birthYear: null,
  heightCm: null,
  weightKg: null,
  activityLevel: "moderate",
  calorieBand: null,
  timezone: "UTC",
  publicLogs: false,
  showPhoneOnProfile: false,
  phone: null,
});

export const GLUTEN_ID = "64b000000000000000000001";
export const MILK_ID = "64b000000000000000000002";

/** Two entries, in the API's order (display name): Gluten with a re-match left, Milk edited by a Curator. */
export const DICTIONARY = AllergenListResponse.parse({
  allergens: [
    {
      id: GLUTEN_ID,
      key: "gluten",
      displayName: "Gluten",
      tier: "sensitivity",
      synonyms: ["wheat", "barley", "rye"],
      descriptionKeywords: ["bread"],
      excludePhrases: ["buckwheat"],
      source: "seed",
      rematchPending: true,
    },
    {
      id: MILK_ID,
      key: "milk",
      displayName: "Milk",
      tier: "allergy",
      synonyms: ["whey", "casein"],
      descriptionKeywords: [],
      excludePhrases: ["cocoa butter"],
      source: "curator",
      rematchPending: false,
    },
  ],
});

export const CURATOR_PROFILE = CuratorProfileView.parse({
  kind: "curator",
  credentials: null,
  bio: null,
  specialties: [],
  publicListing: false,
  editsCount: 3,
  lastEditAt: "2026-11-20T15:00:00.000Z",
});

export const ADMIN_PROFILE = AdminProfileView.parse({
  kind: "admin",
  grantsCount: 4,
  lastAuditAt: "2026-11-21T15:00:00.000Z",
  internalNote: null,
});
