import { Router } from "express";
import {
  AdminUserDetail,
  AdminUserListResponse,
  AdminUsersQuery,
  RoleUpdateInput,
  StatusUpdateInput,
} from "@healtheat/shared";
import { asyncHandler } from "../lib/http.js";
import { currentUser, requireAuth, requireRole } from "../middleware/auth.js";
import * as admin from "../services/admin.js";
import { setRoles } from "../services/roles.js";

// /api/admin/*: account management (design doc REST table, D18: Admin manages accounts only, never logs
// or the dictionary). Role grants came with T7, the rest with T21; delete is the T5 cascade.
export const adminRouter = Router();

adminRouter.use(...requireAuth, requireRole("admin"));

adminRouter.get(
  "/users",
  asyncHandler(async (req, res) => {
    const query = AdminUsersQuery.parse(req.query);
    res.json(AdminUserListResponse.parse(await admin.listUsers(query)));
  }),
);

/** The named account; when it is the caller, the already-loaded document, so the request stays consistent. */
async function target(res: Parameters<typeof currentUser>[0], username: string) {
  const actor = currentUser(res);
  const found = await admin.findAccount(username);
  return { actor, target: actor._id.equals(found._id) ? actor : found };
}

adminRouter.get(
  "/users/:username",
  asyncHandler(async (req, res) => {
    const { target: user } = await target(res, String(req.params.username));
    res.json(AdminUserDetail.parse(await admin.userDetail(user)));
  }),
);

adminRouter.put(
  "/users/:username/roles",
  asyncHandler(async (req, res) => {
    const { roles } = RoleUpdateInput.parse(req.body);
    const { actor, target: user } = await target(res, String(req.params.username));
    await setRoles(actor, user, roles);
    res.json(AdminUserDetail.parse(await admin.userDetail(user)));
  }),
);

adminRouter.put(
  "/users/:username/status",
  asyncHandler(async (req, res) => {
    const { status } = StatusUpdateInput.parse(req.body);
    const { actor, target: user } = await target(res, String(req.params.username));
    await admin.setStatus(actor, user, status);
    res.json(AdminUserDetail.parse(await admin.userDetail(user)));
  }),
);

adminRouter.delete(
  "/users/:username",
  asyncHandler(async (req, res) => {
    const { actor, target: user } = await target(res, String(req.params.username));
    await admin.deleteUser(actor, user);
    res.status(204).end();
  }),
);
