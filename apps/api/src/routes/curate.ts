import { Router } from "express";
import {
  AllergenWriteResponse,
  RematchProgress,
  UnmatchedActionInput,
  UnmatchedListResponse,
  UnmatchedQuery,
  UnmatchedTokenView,
} from "@healtheat/shared";
import { z } from "zod";
import { asyncHandler } from "../lib/http.js";
import { currentUser, requireAuth, requireRole } from "../middleware/auth.js";
import { CuratorProfile } from "../models/index.js";
import { continueRematch } from "../services/dictionary.js";
import { actOnToken, listUnmatched } from "../services/unmatched.js";

// /api/curate/*: Curator tools (design doc REST table, D18): continuing a re-match, and the
// unmatched-ingredient queue (T22).
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

// The unmatched-ingredient queue (T22): phrases no synonym matched, most frequent first.
curateRouter.get(
  "/unmatched",
  asyncHandler(async (req, res) => {
    res.json(UnmatchedListResponse.parse(await listUnmatched(UnmatchedQuery.parse(req.query))));
  }),
);

const ActionResponse = z.object({
  token: UnmatchedTokenView,
  write: AllergenWriteResponse.nullable(),
});

// Map a phrase to an allergen (a dictionary edit: it re-matches and counts on the Curator's profile) or
// ignore it. A map whose re-match ran out of time answers 202, like any allergen write.
curateRouter.put(
  "/unmatched/:token",
  asyncHandler(async (req, res) => {
    const input = UnmatchedActionInput.parse(req.body);
    const result = await actOnToken(String(req.params.token), input, currentUser(res)._id);
    if (result.write)
      await CuratorProfile.updateOne(
        { userId: currentUser(res)._id },
        { $inc: { editsCount: 1 }, $set: { lastEditAt: new Date() } },
      );
    res
      .status(result.write && !result.write.rematch.done ? 202 : 200)
      .json(ActionResponse.parse(result));
  }),
);
