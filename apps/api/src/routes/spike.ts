// Plan task T1, the proxy spike. Three routes prove that, through the Next.js rewrite on
// Vercel, (1) a Set-Cookie from Express is stored on the web origin, (2) the cookie comes
// back on the next request, and (3) a long request survives the proxy.
import { Router } from "express";
import type { WhoAmI } from "@healtheat/shared";

export const spikeRouter = Router();
export const SPIKE_COOKIE = "he_spike";

const secureCookies = process.env.NODE_ENV === "production" || process.env.VERCEL === "1";

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
  const started = Date.now();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  res.json({ ok: true, waitedMs: Date.now() - started });
});
