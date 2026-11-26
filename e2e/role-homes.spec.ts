import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { AdminUserListResponse, UnmatchedListResponse } from "../packages/shared/src/index";
import { makeAccount } from "./helpers";
import { ADMIN_PROFILE, CURATOR_PROFILE, DICTIONARY, mockSession } from "./role-mocks";

// Lane B (T21 web half): Home by active role (design doc, Pages table, Home row; R3-7) and the nav's
// "View as" switch. Done when: the three Home screens render differently for the three roles. A member
// runs against the real stack; Curator and Admin sessions are mocked (e2e/role-mocks.ts says why).

async function signUp(page: Page, prefix: string) {
  // page.request shares the tab's cookies: this signs the tab in.
  const res = await page.request.post("/api/auth/register", { data: makeAccount(prefix) });
  expect(res.status(), await res.text()).toBe(201);
}

test("a member, from the real API: Member Home, no view switch, and the Curator and Admin pages are not theirs", async ({
  page,
}) => {
  await signUp(page, "rh");
  await page.goto("/");
  await expect(page.getByTestId("member-home")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("nav-role")).toHaveText("Member");
  await expect(page.getByTestId("nav-view")).toHaveCount(0);
  await expect(page.getByTestId("nav-day-log")).toBeVisible();
  await expect(page.getByTestId("nav-dictionary")).toHaveCount(0);
  await expect(page.getByTestId("nav-users")).toHaveCount(0);

  for (const [path, who] of [
    ["/curate/allergens", "Curators"],
    ["/curate/allergens/milk", "Curators"],
    ["/curate/allergens/new", "Curators"],
    ["/admin/users", "Admins"],
    ["/admin/users/someone", "Admins"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByTestId("role-required")).toContainText(`This page is for ${who}`, {
      timeout: 30_000,
    });
  }

  // The API agrees: the member cannot take a role view it does not hold.
  const res = await page.request.put("/api/users/me/active-role", { data: { role: "curator" } });
  expect(res.status()).toBe(403);
});

test("signed-out visitors are sent to log in from the Curator and Admin pages", async ({
  page,
}) => {
  for (const path of ["/curate/allergens", "/curate/allergens/milk", "/admin/users"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/, { timeout: 30_000 });
  }
});

/** The routes the three Homes call, answered from mocks. */
async function mockHomeRoutes(page: Page) {
  // Member Home: its own spec covers the content; here only which Home renders matters.
  await page.route("**/api/users/me/summary*", (route) =>
    route.fulfill({ status: 503, json: { error: "database_unavailable" } }),
  );
  await page.route("**/api/allergens", (route) => route.fulfill({ json: DICTIONARY }));
  await page.route("**/api/curate/unmatched*", (route) =>
    route.fulfill({
      json: UnmatchedListResponse.parse({ tokens: [], page: 1, total: 12 }),
    }),
  );
  await page.route("**/api/users/me/profiles/curator", (route) =>
    route.fulfill({ json: CURATOR_PROFILE }),
  );
  await page.route("**/api/users/me/profiles/admin", (route) =>
    route.fulfill({ json: ADMIN_PROFILE }),
  );
  await page.route("**/api/admin/users*", (route) =>
    route.fulfill({
      json: AdminUserListResponse.parse({
        users: [
          {
            username: "mock_all",
            email: "mock_all@example.com",
            roles: ["member", "curator", "admin"],
            status: "active",
            activeRole: "admin",
            deletionPending: false,
            createdAt: "2026-11-01T00:00:00.000Z",
          },
        ],
        page: 1,
        pageSize: 20,
        total: 1,
      }),
    }),
  );
}

const HOMES = ["member-home", "curator-home", "admin-home"] as const;

/** "View as": choose a view, then press Switch (choosing alone never switches). */
async function switchTo(page: Page, role: "member" | "curator" | "admin") {
  await page.getByTestId("nav-view").selectOption(role);
  await page.getByTestId("nav-view-switch").click();
}

async function expectOnlyHome(page: Page, home: (typeof HOMES)[number]) {
  await expect(page.getByTestId(home)).toBeVisible({ timeout: 30_000 });
  for (const other of HOMES.filter((h) => h !== home))
    await expect(page.getByTestId(other)).toHaveCount(0);
  await expect(page.getByTestId("public-home")).toHaveCount(0);
}

test("one account holding all three roles: View as switches between three different Homes and navs", async ({
  page,
}) => {
  const session = await mockSession(page, {
    username: "mock_all",
    roles: ["member", "curator", "admin"],
    activeRole: "member",
  });
  await mockHomeRoutes(page);
  await page.goto("/");

  // Member: the week, the log bar and Day log.
  await expectOnlyHome(page, "member-home");
  await expect(page.getByTestId("nav-role")).toHaveCount(0);
  const view = page.getByTestId("nav-view");
  await expect(view).toHaveValue("member");
  await expect(page.getByTestId("nav-day-log")).toBeVisible();
  await expect(page.getByTestId("log-bar")).toBeVisible();

  // Curator: dictionary health and the Dictionary link instead of Day log.
  await switchTo(page, "curator");
  await expectOnlyHome(page, "curator-home");
  expect(session.switches).toEqual([{ role: "curator" }]);
  await expect(view).toHaveValue("curator");
  await expect(page.getByTestId("nav-dictionary")).toHaveAttribute("href", "/curate/allergens");
  await expect(page.getByTestId("nav-day-log")).toHaveCount(0);
  await expect(page.getByTestId("curator-dictionary")).toContainText("Allergen dictionary");
  await expect(page.getByTestId("log-bar")).toHaveCount(0);

  // Admin: accounts and the Users link.
  await switchTo(page, "admin");
  await expectOnlyHome(page, "admin-home");
  await expect(page.getByTestId("nav-users")).toHaveAttribute("href", "/admin/users");
  await expect(page.getByTestId("nav-dictionary")).toHaveCount(0);
  await expect(page.getByTestId("admin-users")).toContainText("Users (1)");

  // And back: the view, not the account, changed.
  await switchTo(page, "member");
  await expectOnlyHome(page, "member-home");
  expect(session.switches.map((s) => s.role)).toEqual(["curator", "admin", "member"]);
});

test("the switch opens that view's Home from any page, and a refused switch says so and keeps the view", async ({
  page,
}) => {
  const session = await mockSession(page, {
    username: "mock_cur",
    roles: ["member", "curator"],
    activeRole: "member",
  });
  await mockHomeRoutes(page);
  await page.goto("/about");
  const view = page.getByTestId("nav-view");
  await expect(view).toHaveValue("member", { timeout: 30_000 });
  // An account without Admin is not offered it.
  await expect(view.locator("option")).toHaveText(["Member", "Curator"]);

  await switchTo(page, "curator");
  await expect(page).toHaveURL(/\/$/);
  await expectOnlyHome(page, "curator-home");

  session.failSwitch = { status: 403, error: "forbidden" };
  await switchTo(page, "member");
  await expect(page.getByTestId("nav-view-error")).toContainText("does not hold the role");
  await expect(view).toHaveValue("curator"); // the choice goes back to the view still active
  await expectOnlyHome(page, "curator-home");
});

test("choosing a role in View as, by mouse or arrow keys, switches nothing until Switch is pressed", async ({
  page,
}) => {
  const session = await mockSession(page, {
    username: "mock_all",
    roles: ["member", "curator", "admin"],
    activeRole: "member",
  });
  await mockHomeRoutes(page);
  await page.goto("/about");
  const view = page.getByTestId("nav-view");
  await expect(view).toHaveValue("member", { timeout: 30_000 });
  const switchButton = page.getByTestId("nav-view-switch");
  await expect(switchButton).toBeDisabled(); // the active view is already chosen

  await view.selectOption("curator");
  await view.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page).toHaveURL(/\/about$/);
  expect(session.switches).toEqual([]);

  await view.selectOption("admin");
  await switchButton.click();
  await expectOnlyHome(page, "admin-home");
  expect(session.switches).toEqual([{ role: "admin" }]);
});
