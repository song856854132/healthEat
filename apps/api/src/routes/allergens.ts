import { Router } from "express";
import { AllergenListResponse } from "@healtheat/shared";
import { asyncHandler } from "../lib/http.js";
import { sessionMiddleware } from "../lib/session.js";
import { currentUser, requireAuth, requireRole } from "../middleware/auth.js";
import { CuratorProfile } from "../models/index.js";
import { deleteAllergen, listAllergens } from "../services/dictionary.js";

// /api/allergens: the allergen dictionary (design doc REST table). Reading is public and needs no
// session; writes are the Curator's. DELETE lands with T5 (its cascade, R3-3); POST and PUT with T21.
export const allergensRouter = Router();

allergensRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(AllergenListResponse.parse({ allergens: await listAllergens() }));
  }),
);

const curator = [sessionMiddleware(), ...requireAuth, requireRole("curator")];

allergensRouter.delete(
  "/:id",
  ...curator,
  asyncHandler(async (req, res) => {
    await deleteAllergen(String(req.params.id));
    // Every dictionary write counts toward the Curator's profile (REST table); the profile exists once
    // the role is granted (T7).
    await CuratorProfile.updateOne(
      { userId: currentUser(res)._id },
      { $inc: { editsCount: 1 }, $set: { lastEditAt: new Date() } },
    );
    res.status(204).end();
  }),
);
