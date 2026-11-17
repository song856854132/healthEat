import { Router, type Response } from "express";
import {
  AllergenCreateInput,
  AllergenListResponse,
  AllergenUpdateInput,
  AllergenWriteResponse,
} from "@healtheat/shared";
import { asyncHandler } from "../lib/http.js";
import { sessionMiddleware } from "../lib/session.js";
import { currentUser, requireAuth, requireRole } from "../middleware/auth.js";
import { CuratorProfile } from "../models/index.js";
import {
  createAllergen,
  deleteAllergen,
  listAllergens,
  updateAllergen,
  type AllergenWrite,
} from "../services/dictionary.js";

// /api/allergens: the allergen dictionary (design doc REST table). Reading is public and needs no
// session; writes are the Curator's (D18), and each one counts on the Curator's profile.
export const allergensRouter = Router();

allergensRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(AllergenListResponse.parse({ allergens: await listAllergens() }));
  }),
);

const curator = [sessionMiddleware(), ...requireAuth, requireRole("curator")];

/** Every dictionary write counts toward the Curator's profile (REST table); it exists from the grant (T7). */
async function countEdit(res: Response) {
  await CuratorProfile.updateOne(
    { userId: currentUser(res)._id },
    { $inc: { editsCount: 1 }, $set: { lastEditAt: new Date() } },
  );
}

/** A write answers 202 while its re-match has foods left; the page continues it (curate.ts). */
function sendWrite(res: Response, write: AllergenWrite, doneStatus: number) {
  res.status(write.rematch.done ? doneStatus : 202).json(AllergenWriteResponse.parse(write));
}

allergensRouter.post(
  "/",
  ...curator,
  asyncHandler(async (req, res) => {
    const input = AllergenCreateInput.parse(req.body);
    const write = await createAllergen(input, currentUser(res)._id);
    await countEdit(res);
    sendWrite(res, write, 201);
  }),
);

allergensRouter.put(
  "/:id",
  ...curator,
  asyncHandler(async (req, res) => {
    const input = AllergenUpdateInput.parse(req.body);
    const write = await updateAllergen(String(req.params.id), input, currentUser(res)._id);
    await countEdit(res);
    sendWrite(res, write, 200);
  }),
);

allergensRouter.delete(
  "/:id",
  ...curator,
  asyncHandler(async (req, res) => {
    await deleteAllergen(String(req.params.id));
    await countEdit(res);
    res.status(204).end();
  }),
);
