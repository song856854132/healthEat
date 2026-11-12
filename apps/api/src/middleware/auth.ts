import type { RequestHandler, Response } from "express";
import type { Role } from "@healtheat/shared";
import { HttpError, asyncHandler } from "../lib/http.js";
import { User, type UserDoc } from "../models/User.js";

/** The account loaded by `requireAuth` for this request. Throws when used on an unguarded route. */
export function currentUser(res: Response): UserDoc {
  const user = res.locals.user as UserDoc | undefined;
  if (!user) throw new Error("currentUser() called on a route without requireAuth");
  return user;
}

/** 403 for an account that may hold a session but must not act: suspended or being deleted (D-S5). */
export function accountBlocked(
  user: Pick<UserDoc, "status" | "deletionPending">,
): HttpError | null {
  if (user.deletionPending) return new HttpError(403, "account_deletion_pending");
  if (user.status !== "active") return new HttpError(403, "account_suspended");
  return null;
}

const requireSession: RequestHandler = (req, _res, next) => {
  if (!req.session?.userId) return next(new HttpError(401, "unauthenticated"));
  next();
};

// Loads the account on every authenticated request (one indexed read): a suspension or deletion
// takes effect on the next request, not at the next login, and the session is destroyed on the spot.
const loadUser = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.session.userId);
  if (!user) {
    await destroySession(req);
    throw new HttpError(401, "unauthenticated");
  }
  const blocked = accountBlocked(user);
  if (blocked) {
    await destroySession(req);
    throw blocked;
  }
  // The User document is the source of truth; the session copy is what the web reads most often.
  if (req.session.activeRole !== user.activeRole) req.session.activeRole = user.activeRole;
  res.locals.user = user;
  next();
});

/** 401 without a session, 403 for a blocked account; otherwise `currentUser(res)` is set. */
export const requireAuth: RequestHandler[] = [requireSession, loadUser];

/** 403 unless the account holds `role` (design doc: checks `roles`, never `activeRole`). After requireAuth. */
export function requireRole(role: Role): RequestHandler {
  return (_req, res, next) => {
    if (!currentUser(res).roles.includes(role)) return next(new HttpError(403, "forbidden"));
    next();
  };
}

export function destroySession(req: {
  session: { destroy(cb: (err?: unknown) => void): unknown };
}) {
  return new Promise<void>((resolve, reject) =>
    req.session.destroy((err) => (err ? reject(err) : resolve())),
  );
}

export function regenerateSession(req: {
  session: { regenerate(cb: (err?: unknown) => void): unknown };
}) {
  return new Promise<void>((resolve, reject) =>
    req.session.regenerate((err) => (err ? reject(err) : resolve())),
  );
}
