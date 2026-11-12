import { Router } from "express";
import { ActiveRoleInput, MeResponse } from "@healtheat/shared";
import { asyncHandler } from "../lib/http.js";
import { currentUser, requireAuth } from "../middleware/auth.js";
import * as auth from "../services/auth.js";

// /api/users/me/*: account routes scoped to the caller (design doc REST table). Profile edits and
// account deletion (T5) land here later.
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
