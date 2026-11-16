import { Router } from "express";
import { LogEntryUpdateInput, LogEntryView } from "@healtheat/shared";
import { asyncHandler } from "../lib/http.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { ownedLogEntry, requireOwner } from "../middleware/requireOwner.js";
import * as logs from "../services/logs.js";

// /api/logs/:id: edit or delete one of your own log entries (design doc REST table, A2). Listing and
// creating are `me`-scoped under /api/users/me/logs (routes/users.ts).
export const logsRouter = Router();

const guard = [...requireAuth, requireRole("member"), requireOwner];

logsRouter.put(
  "/:id",
  ...guard,
  asyncHandler(async (req, res) => {
    const input = LogEntryUpdateInput.parse(req.body);
    res.json(LogEntryView.parse(await logs.updateLog(ownedLogEntry(res), input)));
  }),
);

logsRouter.delete(
  "/:id",
  ...guard,
  asyncHandler(async (_req, res) => {
    await ownedLogEntry(res).deleteOne();
    res.status(204).end();
  }),
);
