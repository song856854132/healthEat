import type { RequestHandler, Response } from "express";
import { HttpError, asyncHandler } from "../lib/http.js";
import { LogEntry } from "../models/index.js";
import type { LogEntryDoc } from "../models/LogEntry.js";
import { currentUser } from "./auth.js";

/** The entry `requireOwner` loaded for this request. Throws on a route without it. */
export function ownedLogEntry(res: Response): LogEntryDoc {
  const entry = res.locals.logEntry as LogEntryDoc | undefined;
  if (!entry) throw new Error("ownedLogEntry() called on a route without requireOwner");
  return entry;
}

/**
 * Ownership guard for `/api/logs/:id` (design doc A2). After requireAuth: an id that names no entry is
 * 404 `log_not_found`; another account's entry is 403 `forbidden`, whatever roles the caller holds
 * (Curators and Admins never read a member's logs, D18).
 */
export const requireOwner: RequestHandler = asyncHandler(async (req, res, next) => {
  const id = req.params.id;
  if (typeof id !== "string" || !/^[a-f0-9]{24}$/i.test(id))
    throw new HttpError(404, "log_not_found");
  const entry = await LogEntry.findById(id);
  if (!entry) throw new HttpError(404, "log_not_found");
  if (!entry.userId.equals(currentUser(res)._id)) throw new HttpError(403, "forbidden");
  res.locals.logEntry = entry;
  next();
});
