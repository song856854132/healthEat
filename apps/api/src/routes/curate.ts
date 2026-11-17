import { Router } from "express";
import { RematchProgress } from "@healtheat/shared";
import { asyncHandler } from "../lib/http.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { continueRematch } from "../services/dictionary.js";

// /api/curate/*: Curator tools (design doc REST table, D18). The unmatched-ingredient queue joins in
// phase 3 (T22).
export const curateRouter = Router();

curateRouter.use(...requireAuth, requireRole("curator"));

// Continues an unfinished re-match from the allergen's cursor (a write's 202, or a request lost to a
// timeout or a closed tab). 200 when done, 202 while foods are left. Not a dictionary edit: it does not
// count on the Curator's profile.
curateRouter.post(
  "/allergens/:id/rematch",
  asyncHandler(async (req, res) => {
    const progress = await continueRematch(String(req.params.id));
    res.status(progress.done ? 200 : 202).json(RematchProgress.parse(progress));
  }),
);
