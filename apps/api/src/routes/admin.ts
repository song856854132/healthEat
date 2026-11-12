import { Router } from "express";
import { MeResponse, RoleUpdateInput } from "@healtheat/shared";
import { HttpError, asyncHandler } from "../lib/http.js";
import { currentUser, requireAuth, requireRole } from "../middleware/auth.js";
import { User } from "../models/index.js";
import * as auth from "../services/auth.js";
import { setRoles } from "../services/roles.js";

// /api/admin/*: account management (design doc REST table, D18: Admin manages accounts only). T7 adds
// the role grant; listing, status and delete land with T21 and T5.
export const adminRouter = Router();

adminRouter.use(...requireAuth, requireRole("admin"));

adminRouter.put(
  "/users/:username/roles",
  asyncHandler(async (req, res) => {
    const { roles } = RoleUpdateInput.parse(req.body);
    const target = await User.findOne({ username: String(req.params.username).toLowerCase() });
    if (!target) throw new HttpError(404, "not_found");
    const actor = currentUser(res);
    // Acting on yourself: change the loaded document so this request's own state stays consistent.
    await setRoles(actor, actor._id.equals(target._id) ? actor : target, roles);
    res.json(MeResponse.parse(await auth.me(actor._id.equals(target._id) ? actor : target)));
  }),
);
