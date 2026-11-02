import { expect, test } from "@playwright/test";

// Acceptance tests for plan task T1 (proxy spike). BASE_URL is the Next.js origin; every
// request here goes through the /api/* rewrite to Express.

test("home renders and health comes back through the proxy", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("healthEat");
  const health = page.getByTestId("health");
  await expect(health).toContainText('"ok": true', { timeout: 30_000 });
  await expect(health).toContainText("healtheat-api");
});

test("Set-Cookie from Express is honoured on the web origin", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByTestId("whoami")).toHaveText("anonymous", { timeout: 30_000 });
  await page.getByTestId("login").click();
  await expect(page.getByTestId("whoami")).toHaveText("spike-user", { timeout: 30_000 });
  const cookies = await context.cookies();
  const spike = cookies.find((c) => c.name === "he_spike");
  expect(spike, "cookie stored by the browser for the web origin").toBeTruthy();
  expect(spike?.httpOnly).toBe(true);
  // Reload: the cookie must come back on the next request.
  await page.reload();
  await expect(page.getByTestId("whoami")).toHaveText("spike-user", { timeout: 30_000 });
  await page.getByTestId("logout").click();
  await expect(page.getByTestId("whoami")).toHaveText("anonymous", { timeout: 30_000 });
});

test("a 65 s request completes through the proxy", async ({ request }) => {
  test.slow();
  const started = Date.now();
  const res = await request.get("/api/spike/slow?seconds=65", { timeout: 110_000 });
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { ok: boolean; waitedMs: number };
  expect(body.ok).toBe(true);
  expect(body.waitedMs).toBeGreaterThanOrEqual(65_000);
  expect(Date.now() - started).toBeGreaterThanOrEqual(65_000);
});
