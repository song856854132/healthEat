import { Router } from "express";
import {
  ActiveRoleInput,
  AdminProfileInput,
  CuratorProfileInput,
  EditableProfileKind,
  LogEntryCreateInput,
  LogEntryCreated,
  LogListResponse,
  LogsQuery,
  MeResponse,
  RoleProfileView,
  SESSION_COOKIE,
  SummaryQuery,
  SummaryResponse,
  UserAllergensInput,
  UserAllergensResponse,
} from "@healtheat/shared";
import { HttpError, asyncHandler } from "../lib/http.js";
import { currentUser, destroySession, requireAuth, requireRole } from "../middleware/auth.js";
import { deleteAccount } from "../services/account.js";
import * as auth from "../services/auth.js";
import * as logs from "../services/logs.js";
import * as profiles from "../services/profiles.js";
import { summaryFor } from "../services/summary.js";

// /api/users/me/*: routes scoped to the caller (design doc REST table). There is no route that names
// another member, so no account can address someone else's logs or allergen settings (A2, D18).
// Role profiles: the Curator's and the Admin's (T21); the member profile edit is not built yet.
export const usersRouter = Router();

// Deletes the caller's account and everything it owns (T5 cascade, D6), then ends this session. The
// only usable Admin cannot delete themselves (409 last_admin, the same lockout guard as role changes).
// A failure part way leaves the account flagged `deletionPending` (locked): the cascade is retried once
// here, and logging in again with the right password finishes it (services/auth.ts login).
usersRouter.delete(
  "/me",
  ...requireAuth,
  asyncHandler(async (req, res) => {
    const userId = currentUser(res)._id;
    try {
      await deleteAccount(userId, { keepAnAdmin: true });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      await deleteAccount(userId, { keepAnAdmin: true });
    }
    await destroySession(req);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.status(204).end();
  }),
);

usersRouter.put(
  "/me/active-role",
  ...requireAuth,
  asyncHandler(async (req, res) => {
    const { role } = ActiveRoleInput.parse(req.body);
    const user = currentUser(res);
    await auth.setActiveRole(user, role);
    req.session.activeRole = role;
    res.json(MeResponse.parse(await auth.me(user)));
  }),
);

// The caller's own role profile, for a role they hold (403 otherwise). An unknown kind, or `member`
// (not editable yet), is a 400 from the kind schema.
usersRouter.get(
  "/me/profiles/:kind",
  ...requireAuth,
  asyncHandler(async (req, res) => {
    const kind = EditableProfileKind.parse(req.params.kind);
    res.json(RoleProfileView.parse(await profiles.getProfile(currentUser(res), kind)));
  }),
);

usersRouter.put(
  "/me/profiles/:kind",
  ...requireAuth,
  asyncHandler(async (req, res) => {
    const kind = EditableProfileKind.parse(req.params.kind);
    const input =
      kind === "curator" ? CuratorProfileInput.parse(req.body) : AdminProfileInput.parse(req.body);
    res.json(RoleProfileView.parse(await profiles.updateProfile(currentUser(res), kind, input)));
  }),
);

// Every account is a member (D18); the role check keeps member data routes explicit.
const member = [...requireAuth, requireRole("member")];

usersRouter.get(
  "/me/logs",
  ...member,
  asyncHandler(async (req, res) => {
    const query = LogsQuery.parse(req.query);
    res.json(LogListResponse.parse(await logs.listLogs(currentUser(res)._id, query)));
  }),
);

usersRouter.post(
  "/me/logs",
  ...member,
  asyncHandler(async (req, res) => {
    const input = LogEntryCreateInput.parse(req.body);
    res.status(201).json(LogEntryCreated.parse(await logs.createLog(currentUser(res)._id, input)));
  }),
);

usersRouter.get(
  "/me/allergens",
  ...member,
  asyncHandler(async (_req, res) => {
    const allergens = await logs.listUserAllergens(currentUser(res)._id);
    res.json(UserAllergensResponse.parse({ allergens }));
  }),
);

usersRouter.put(
  "/me/allergens",
  ...member,
  asyncHandler(async (req, res) => {
    const input = UserAllergensInput.parse(req.body);
    const allergens = await logs.setUserAllergens(currentUser(res)._id, input);
    res.json(UserAllergensResponse.parse({ allergens }));
  }),
);

// The member's week (T25): coverage bands, today's calorie meter, exposure meter and today's alerts.
usersRouter.get(
  "/me/summary",
  ...member,
  asyncHandler(async (req, res) => {
    const { weekEnding } = SummaryQuery.parse(req.query);
    res.json(SummaryResponse.parse(await summaryFor(currentUser(res)._id, weekEnding)));
  }),
);
