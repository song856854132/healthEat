import { Router } from "express";
import { AllergenListResponse } from "@healtheat/shared";
import { asyncHandler } from "../lib/http.js";
import { listAllergens } from "../services/dictionary.js";

// /api/allergens: the allergen dictionary (design doc REST table). Reading is public; Curator writes
// arrive with T21.
export const allergensRouter = Router();

allergensRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(AllergenListResponse.parse({ allergens: await listAllergens() }));
  }),
);
