import { Router } from "express";
import {
  FdcIdParam,
  FoodDetailsResponse,
  FoodSearchQuery,
  FoodSearchResponse,
} from "@healtheat/shared";
import { asyncHandler } from "../lib/http.js";
import { sessionMiddleware } from "../lib/session.js";
import { accountBlocked } from "../middleware/auth.js";
import { User } from "../models/index.js";
import { localStatsFor } from "../services/foodStats.js";
import * as usda from "../services/usda.js";

// /api/foods/*: public USDA search and details (design doc REST table). No session needed: anonymous
// visitors can search too. The database still has to answer, for the shared cache.
export const foodsRouter = Router();

foodsRouter.get(
  "/search",
  asyncHandler(async (req, res) => {
    const query = FoodSearchQuery.parse(req.query);
    res.json(FoodSearchResponse.parse(await usda.searchFoods(query)));
  }),
);

// Details read the session only here (search stays session-free; sessions roll, so mounting it on the
// whole router would rewrite a signed-in caller's session on every search). A signed-in caller that is
// suspended or being deleted gets the anonymous view (T28).
foodsRouter.get(
  "/:fdcId",
  sessionMiddleware(),
  asyncHandler(async (req, res) => {
    const fdcId = FdcIdParam.parse(req.params.fdcId);
    const details = await usda.getFood(fdcId);
    const user = req.session?.userId ? await User.findById(req.session.userId) : null;
    const viewer = user && !accountBlocked(user) ? user : null;
    res.json(
      FoodDetailsResponse.parse({ ...details, localStats: await localStatsFor(fdcId, viewer) }),
    );
  }),
);
