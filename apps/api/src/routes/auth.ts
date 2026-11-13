import { Router, type Request, type Response } from "express";
import {
  LoginInput,
  MeResponse,
  PRIVACY_ACK_COOKIE,
  RegisterInput,
  SESSION_COOKIE,
} from "@healtheat/shared";
import { asyncHandler } from "../lib/http.js";
import { isDeployed } from "../lib/env.js";
import { destroySession, regenerateSession, requireAuth, currentUser } from "../middleware/auth.js";
import * as auth from "../services/auth.js";
import type { UserDoc } from "../models/User.js";

export const authRouter = Router();

const PRIVACY_ACK_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

const privacyAcknowledged = (req: Request): boolean =>
  typeof req.cookies?.[PRIVACY_ACK_COOKIE] === "string" && req.cookies[PRIVACY_ACK_COOKIE] !== "";

/**
 * Start a session for `user`: a fresh session id (no fixation from a pre-login cookie), the privacy
 * acknowledgment mirrored both ways (cookie -> User.privacyAckAt on this device, User.privacyAckAt ->
 * cookie on a new device; the banner reads the cookie, so it is not httpOnly), then the /me payload.
 */
async function startSession(req: Request, res: Response, user: UserDoc, status: number) {
  if (privacyAcknowledged(req)) await auth.acknowledgePrivacy(user);
  if (user.privacyAckAt) {
    res.cookie(PRIVACY_ACK_COOKIE, "1", {
      httpOnly: false,
      secure: isDeployed(),
      sameSite: "lax",
      maxAge: PRIVACY_ACK_MAX_AGE_MS,
      path: "/",
    });
  }
  await regenerateSession(req);
  req.session.userId = user.id;
  req.session.activeRole = user.activeRole;
  res.status(status).json(MeResponse.parse(await auth.me(user)));
}

authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const input = RegisterInput.parse(req.body);
    const user = await auth.register(input, privacyAcknowledged(req));
    await startSession(req, res, user, 201);
  }),
);

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const user = await auth.login(LoginInput.parse(req.body), req.ip);
    await startSession(req, res, user, 200);
  }),
);

// Idempotent: without a session it still answers 200 and clears the cookie.
authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    if (req.session) await destroySession(req);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  }),
);

authRouter.get(
  "/me",
  ...requireAuth,
  asyncHandler(async (_req, res) => {
    res.json(MeResponse.parse(await auth.me(currentUser(res))));
  }),
);
