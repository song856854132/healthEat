import { Router } from "express";
import { FdcIdParam, FoodDetails, FoodSearchQuery, FoodSearchResponse } from "@healtheat/shared";
import { asyncHandler } from "../lib/http.js";
import * as usda from "../services/usda.js";

// /api/foods/*: public USDA search and details (design doc REST table). No session: anonymous
// visitors can search too. The database still has to answer, for the shared cache.
export const foodsRouter = Router();

foodsRouter.get(
  "/search",
  asyncHandler(async (req, res) => {
    const query = FoodSearchQuery.parse(req.query);
    res.json(FoodSearchResponse.parse(await usda.searchFoods(query)));
  }),
);

foodsRouter.get(
  "/:fdcId",
  asyncHandler(async (req, res) => {
    const fdcId = FdcIdParam.parse(req.params.fdcId);
    res.json(FoodDetails.parse(await usda.getFood(fdcId)));
  }),
);
