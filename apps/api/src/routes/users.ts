import { Router } from "express";
import {
  ActiveRoleInput,
  LogEntryCreateInput,
  LogEntryCreated,
  LogListResponse,
  LogsQuery,
  MeResponse,
  UserAllergensInput,
  UserAllergensResponse,
} from "@healtheat/shared";
import { asyncHandler } from "../lib/http.js";
import { currentUser, requireAuth, requireRole } from "../middleware/auth.js";
import * as auth from "../services/auth.js";
import * as logs from "../services/logs.js";

// /api/users/me/*: routes scoped to the caller (design doc REST table). There is no route that names
// another member, so no account can address someone else's logs or allergen settings (A2, D18).
// Profile edits and account deletion (T5) land here later.
export const usersRouter = Router();

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
