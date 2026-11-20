import { Router } from "express";
import { PublicHomeResponse } from "@healtheat/shared";
import { asyncHandler } from "../lib/http.js";
import { publicFeed } from "../services/home.js";

// /api/home: the anonymous Home feed (T10). Public and session-free.
export const homeRouter = Router();

homeRouter.get(
  "/public",
  asyncHandler(async (_req, res) => {
    res.json(PublicHomeResponse.parse(await publicFeed()));
  }),
);
