import { expect, test } from "@playwright/test";

// Acceptance of plan task T9b through the Vercel preview: register and log in via the web origin's
// /api/* rewrite, so the session cookie set by Express is stored for the web origin and comes back
// on the next request. The `request` fixture keeps cookies like a browser tab would. Each run
// registers a fresh throwaway account (there is no delete route before T5).
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const account = {
  username: `e2e_${suffix}`.slice(0, 24),
  email: `e2e_${suffix}@example.com`,
  password: "e2e correct horse battery",
  timezone: "UTC",
};

test("register, me, logout and login through the proxy keep one same-origin session", async ({
  request,
  baseURL,
}) => {
  expect(baseURL, "Playwright baseURL").toBeTruthy();
  const reg = await request.post("/api/auth/register", { data: account });
  expect(reg.status(), await reg.text()).toBe(201);
  const created = (await reg.json()) as {
    user: { username: string };
    profiles: { member: boolean };
  };
  expect(created.user.username).toBe(account.username);
  expect(created.profiles.member).toBe(true);
  const setCookie = reg.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie");
  const sid = setCookie.find((h) => h.value.startsWith("he_sid="));
  expect(sid, "session cookie reached the browser side of the proxy").toBeTruthy();
  expect(sid!.value).toMatch(/HttpOnly/);
  expect(sid!.value).toMatch(/SameSite=Lax/);
  // Secure on every deployment (https); the local stack is plain http and must not set it.
  if (baseURL!.startsWith("https://")) expect(sid!.value).toMatch(/Secure/);
  else expect(sid!.value).not.toMatch(/Secure/);

  const me = await request.get("/api/auth/me");
  expect(me.status(), await me.text()).toBe(200);
  expect(((await me.json()) as { user: { username: string } }).user.username).toBe(
    account.username,
  );

  const out = await request.post("/api/auth/logout");
  expect(out.status()).toBe(200);
  const anon = await request.get("/api/auth/me");
  expect(anon.status()).toBe(401);

  const bad = await request.post("/api/auth/login", {
    data: { username: account.username, password: "wrong password" },
  });
  expect(bad.status()).toBe(401);
  expect(await bad.json()).toEqual({ error: "invalid_credentials" });

  const login = await request.post("/api/auth/login", {
    data: { username: account.username, password: account.password },
  });
  expect(login.status(), await login.text()).toBe(200);
  const again = await request.get("/api/auth/me");
  expect(again.status()).toBe(200);
});
