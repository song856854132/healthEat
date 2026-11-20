// Plan task T1, the proxy spike. Three routes prove that, through the Next.js rewrite on
// Vercel, (1) a Set-Cookie from Express is stored on the web origin, (2) the cookie comes
// back on the next request, and (3) a long request survives the proxy.
import { Router } from "express";
import type { WhoAmI } from "@healtheat/shared";
import { env, isProduction } from "../lib/env.js";

export const spikeRouter = Router();
export const SPIKE_COOKIE = "he_spike";

const secureCookies = isProduction() || env().VERCEL === "1";

spikeRouter.post("/login", (req, res) => {
  const name =
    typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : "spike";
  res.cookie(SPIKE_COOKIE, name, {
    httpOnly: true,
    secure: secureCookies,
    sameSite: "lax",
    signed: true,
    maxAge: 60 * 60 * 1000,
    path: "/",
  });
  res.json({ ok: true, name });
});

spikeRouter.get("/whoami", (req, res) => {
  const raw = req.signedCookies?.[SPIKE_COOKIE];
  const body: WhoAmI = { name: typeof raw === "string" ? raw : null };
  res.json(body);
});

spikeRouter.post("/logout", (_req, res) => {
  res.clearCookie(SPIKE_COOKIE, { path: "/" });
  res.json({ ok: true });
});

// Waits `seconds` (max 240) and returns. 65 s through the proxy is the acceptance test for
// the 300 s Vercel function window; keep well under it.
spikeRouter.get("/slow", async (req, res) => {
  const requested = Number(req.query.seconds ?? 65);
  const seconds = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), 240) : 65;
  res.json({ ok: true, waitedMs: await waitAtLeast(seconds * 1000) });
});

// Sleeps until at least `ms` have passed on the monotonic clock and returns the wait in
// whole milliseconds, rounded up. A timer can wake a fraction of a millisecond early by
// another clock (#43: Date.now() read 64999 for a 65 s timer), so it tops up until the
// measured wait reaches `ms`.
export async function waitAtLeast(
  ms: number,
  now: () => number = () => performance.now(),
  sleep: (ms: number) => Promise<unknown> = (d) => new Promise((r) => setTimeout(r, d)),
): Promise<number> {
  const started = now();
  let waited = 0;
  for (let next = ms; next > 0; next = Math.ceil(ms - waited)) {
    await sleep(next);
    waited = now() - started;
  }
  return Math.ceil(waited);
}
