import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { AdminUserDetail, AdminUserListResponse } from "../packages/shared/src/index";
import type { AdminUserView, Role } from "../packages/shared/src/index";
import { AdminProfileView } from "../packages/shared/src/index";
import { ADMIN_PROFILE, mockSession } from "./role-mocks";

// Lane B (T21 web half): Admin Home and the account pages, /admin/users and /admin/users/[username]
// (design doc, Pages table: list and filter, grant or revoke Curator and Admin, suspend or reactivate,
// delete with the same cascade as self-delete). The session and the routes are mocked
// (e2e/role-mocks.ts says why); each spec checks what the page sends as well as what it shows.

const ADMIN = "mock_admin";

function account(username: string, over: Partial<AdminUserView> = {}): AdminUserView {
  return {
    username,
    email: `${username}@example.com`,
    roles: ["member"],
    status: "active",
    activeRole: "member",
    deletionPending: false,
    createdAt: "2026-11-02T12:00:00.000Z",
    ...over,
  };
}

const ACCOUNTS: AdminUserView[] = [
  account("dana_rd", { roles: ["member", "curator"], activeRole: "curator" }),
  account(ADMIN, { roles: ["member", "admin"], activeRole: "admin" }),
  account("spam_bot", { status: "suspended", deletionPending: true }),
];

/** An Admin session; GET /api/admin/users filters `accounts` the way the API does. */
async function asAdmin(page: Page, accounts: AdminUserView[] = structuredClone(ACCOUNTS)) {
  await mockSession(page, { username: ADMIN, roles: ["member", "admin"], activeRole: "admin" });
  await page.route("**/api/users/me/profiles/admin", (route) =>
    route.fulfill({ json: ADMIN_PROFILE }),
  );
  const listed: URLSearchParams[] = [];
  await page.route("**/api/admin/users*", (route) => {
    const sp = new URL(route.request().url()).searchParams;
    listed.push(sp);
    const q = sp.get("q") ?? "";
    const role = sp.get("role");
    const status = sp.get("status");
    const users = accounts.filter(
      (u) =>
        (!q || u.username.startsWith(q) || u.email.startsWith(q)) &&
        (!role || u.roles.includes(role as Role)) &&
        (!status || u.status === status),
    );
    return route.fulfill({
      json: AdminUserListResponse.parse({
        users: users.slice(0, 20),
        page: Number(sp.get("page") ?? 1),
        pageSize: 20,
        total: users.length,
      }),
    });
  });
  return { accounts, listed };
}

/** GET and writes on one account, answered from `accounts`. */
async function mockAccountRoutes(page: Page, accounts: AdminUserView[]) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  const detail = (u: AdminUserView) =>
    AdminUserDetail.parse({
      user: { ...u, privacyAckAt: null },
      profiles: {
        member: true,
        curator: u.roles.includes("curator"),
        admin: u.roles.includes("admin"),
      },
    });
  await page.route("**/api/admin/users/**", (route) => {
    const url = new URL(route.request().url());
    const [, , , , name, action] = url.pathname.split("/"); // /api/admin/users/:name/:action
    const method = route.request().method();
    const u = accounts.find((a) => a.username === name);
    if (!u) return route.fulfill({ status: 404, json: { error: "not_found" } });
    if (method === "GET") return route.fulfill({ json: detail(u) });
    const body = method === "DELETE" ? null : route.request().postDataJSON();
    writes.push({ method, path: url.pathname, body });
    if (method === "DELETE") return route.fulfill({ status: 204 });
    if (action === "roles") u.roles = (body as { roles: Role[] }).roles;
    if (action === "status") u.status = (body as { status: "active" | "suspended" }).status;
    return route.fulfill({ json: detail(u) });
  });
  return writes;
}

test("Admin Home: counts by role and status, the user table, and your changes", async ({
  page,
}) => {
  await asAdmin(page);
  await page.goto("/");
  await expect(page.getByTestId("admin-home")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("count-accounts")).toContainText("3");
  await expect(page.getByTestId("count-curators")).toContainText("1");
  await expect(page.getByTestId("count-admins")).toContainText("1");
  await expect(page.getByTestId("count-suspended")).toContainText("1");
  await expect(page.getByTestId("count-curators").getByRole("link")).toHaveAttribute(
    "href",
    "/admin/users?role=curator",
  );
  await expect(page.getByTestId("count-suspended").getByRole("link")).toHaveAttribute(
    "href",
    "/admin/users?status=suspended",
  );

  const rows = page.getByTestId("user-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Curator");
  await expect(rows.nth(1)).toContainText("(you)");
  await expect(rows.nth(2)).toContainText("suspended");
  await expect(rows.nth(2)).toContainText("deletion pending");
  await expect(page.getByTestId("admin-grants")).toContainText("4 account changes");
  // Account fields only: no logs, no dictionary.
  await expect(page.getByTestId("admin-home")).not.toContainText("Allergen dictionary");

  await page.getByTestId("nav-users").click();
  await expect(page).toHaveURL(/\/admin\/users$/, { timeout: 30_000 });
});

test("Users: filters and the page live in the URL, and the API gets them", async ({ page }) => {
  const many = [
    ...structuredClone(ACCOUNTS),
    ...Array.from({ length: 42 }, (_, i) => account(`user_${String(i).padStart(2, "0")}`)),
  ];
  const { listed } = await asAdmin(page, many);
  await page.goto("/admin/users");
  await expect(page.getByTestId("users-results")).toContainText("45 accounts", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("users-page")).toHaveText("Page 1 of 3");
  await page.getByRole("link", { name: "Next →" }).click();
  await expect(page).toHaveURL(/\/admin\/users\?page=2$/);
  await expect(page.getByTestId("users-page")).toHaveText("Page 2 of 3");
  expect(listed.at(-1)?.get("page")).toBe("2");

  await page.getByLabel("Username or email starts with").fill("  Dana ");
  await page.getByLabel("Role").selectOption("curator");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page).toHaveURL(/\/admin\/users\?q=dana&role=curator$/);
  await expect(page.getByTestId("users-results")).toContainText("1 account match");
  await expect(page.getByTestId("user-row")).toHaveCount(1);
  const last = listed.at(-1)!;
  expect([last.get("q"), last.get("role"), last.get("page")]).toEqual(["dana", "curator", null]);

  await page.getByLabel("Status").selectOption("suspended");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page.getByTestId("users-empty")).toContainText("No accounts match");
  await page.getByRole("link", { name: "Clear filters" }).click();
  await expect(page).toHaveURL(/\/admin\/users$/);
  await expect(page.getByTestId("users-results")).toContainText("45 accounts");
});

test("an account: grant Curator, suspend and reactivate, and a refusal is explained", async ({
  page,
}) => {
  const { accounts } = await asAdmin(page);
  const writes = await mockAccountRoutes(page, accounts);
  await page.goto("/admin/users");
  await page.getByRole("link", { name: "spam_bot" }).click({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/admin\/users\/spam_bot$/, { timeout: 30_000 });
  await expect(page.getByTestId("user-status")).toContainText("Suspended");
  await expect(page.getByTestId("user-status")).toContainText("deletion pending");

  await page.getByRole("button", { name: "Reactivate account" }).click();
  await expect(page.getByTestId("user-status")).toContainText("Active");
  await expect(page.getByRole("button", { name: "Suspend account" })).toBeVisible();

  const save = page.getByRole("button", { name: "Save roles" });
  await expect(save).toBeDisabled(); // nothing changed yet
  await page.getByRole("checkbox", { name: /Curator/ }).check();
  await save.click();
  await expect(page.getByTestId("user-role-form").getByRole("status")).toHaveText("Roles saved.");
  await expect(page.getByTestId("user-roles")).toHaveText("Member, Curator");

  await page.getByRole("button", { name: "Suspend account" }).click();
  await expect(page.getByTestId("user-status")).toContainText("Suspended");
  expect(writes.map((w) => [w.method, w.path, w.body])).toEqual([
    ["PUT", "/api/admin/users/spam_bot/status", { status: "active" }],
    ["PUT", "/api/admin/users/spam_bot/roles", { roles: ["member", "curator"] }],
    ["PUT", "/api/admin/users/spam_bot/status", { status: "suspended" }],
  ]);

  // The API's lockout guard, as the page words it.
  await page.route("**/api/admin/users/spam_bot/roles", (route) =>
    route.fulfill({ status: 409, json: { error: "last_admin" } }),
  );
  await page.getByRole("checkbox", { name: /Admin: manages accounts/ }).check();
  await save.click();
  await expect(page.getByTestId("user-role-form").getByRole("alert")).toContainText(
    "no active Admin",
  );
});

test("your own account: Admin, suspension and deletion are not offered", async ({ page }) => {
  const { accounts } = await asAdmin(page);
  await mockAccountRoutes(page, accounts);
  await page.goto(`/admin/users/${ADMIN}`);
  await expect(page.getByTestId("user-facts")).toContainText("(you)", { timeout: 30_000 });
  await expect(page.getByRole("checkbox", { name: /Admin: manages accounts/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Suspend account" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Delete account…" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Delete account on your profile" })).toHaveAttribute(
    "href",
    "/profile",
  );
});

test("delete an account after typing its username; an unknown account says so", async ({
  page,
}) => {
  const { accounts } = await asAdmin(page);
  const writes = await mockAccountRoutes(page, accounts);
  await page.goto("/admin/users/dana_rd");
  await page.getByRole("button", { name: "Delete account…" }).click({ timeout: 30_000 });
  const confirm = page.getByRole("button", { name: "Delete dana_rd permanently" });
  await expect(confirm).toBeDisabled();
  await page.getByLabel(/Type the username/).fill("DANA_RD");
  await confirm.click();
  await expect(page.getByTestId("user-deleted")).toContainText("dana_rd");
  expect(writes).toEqual([{ method: "DELETE", path: "/api/admin/users/dana_rd", body: null }]);

  await page.goto("/admin/users/nobody_here");
  await expect(page.getByTestId("user-missing")).toContainText("nobody_here", { timeout: 30_000 });
  const res = await page.goto("/admin/users/Not%20A%20Name");
  expect(res?.status()).toBe(404);
});

test("Save roles never undoes a role change another Admin made after the page opened", async ({
  page,
}) => {
  const { accounts } = await asAdmin(page);
  const writes = await mockAccountRoutes(page, accounts);
  await page.goto("/admin/users/dana_rd");
  await expect(page.getByTestId("user-roles")).toHaveText("Member, Curator", { timeout: 30_000 });

  // Meanwhile another Admin revokes Curator from dana_rd.
  accounts.find((a) => a.username === "dana_rd")!.roles = ["member"];
  await page.getByRole("checkbox", { name: /Admin: manages accounts/ }).check();
  await page.getByRole("button", { name: "Save roles" }).click();
  await expect(page.getByTestId("user-role-form").getByRole("alert")).toContainText(
    "Another Admin changed this account",
  );
  expect(writes).toEqual([]);
  // The page now shows the roles as stored, so a second save cannot bring Curator back.
  await expect(page.getByTestId("user-roles")).toHaveText("Member");
  await expect(page.getByRole("checkbox", { name: /Curator/ })).not.toBeChecked();
});

test("the Admin profile on /profile: counters shown, the note saved, never to another account", async ({
  page,
}) => {
  const session = await mockSession(page, {
    username: ADMIN,
    roles: ["member", "admin"],
    activeRole: "admin",
  });
  const puts: unknown[] = [];
  await page.route("**/api/users/me/profiles/admin", (route) => {
    if (route.request().method() !== "PUT") return route.fulfill({ json: ADMIN_PROFILE });
    const body = route.request().postDataJSON() as { internalNote: string | null };
    puts.push(body);
    return route.fulfill({ json: AdminProfileView.parse({ ...ADMIN_PROFILE, ...body }) });
  });
  await page.goto("/profile");
  const section = page.getByTestId("admin-profile");
  await expect(section.getByTestId("admin-counters")).toContainText("4 account changes", {
    timeout: 30_000,
  });
  const note = section.getByLabel("Private note (optional)");
  await note.fill("  Rotate the bootstrap Admin in December ");
  await section.getByRole("button", { name: "Save" }).click();
  await expect(section.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  expect(puts).toEqual([{ internalNote: "Rotate the bootstrap Admin in December" }]);

  // Another tab logs in as a different Admin: this page's note is not written to that account.
  session.username = "other_admin";
  await note.fill("A note for mock_admin only");
  await section.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("nav-username")).toHaveText("other_admin", { timeout: 30_000 });
  expect(puts).toHaveLength(1);
});
