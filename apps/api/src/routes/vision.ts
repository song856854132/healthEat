import { Router } from "express";
import {
  MAX_VISION_IMAGE_BYTES,
  VISION_DAILY_LIMIT,
  VisionMealInput,
  VisionMealResponse,
} from "@healtheat/shared";
import { HttpError, asyncHandler } from "../lib/http.js";
import { currentUser, requireAuth, requireRole } from "../middleware/auth.js";
import { proposeItems, requireVisionClient } from "../services/vision.js";
import { refundPhoto, reservePhoto } from "../services/visionUsage.js";

export const visionRouter = Router();

/** Decoded size of a base64 string without decoding it. */
const decodedBytes = (b64: string) =>
  Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

// POST /api/vision/meal (T13): one photo in, proposed {query, grams, confidence} items out; nothing is
// saved. Order matters: input and configuration are checked before the photo is counted, and a failed
// Claude call gives the photo back, so only a successful analysis uses one of the day's 20.
visionRouter.post(
  "/meal",
  ...requireAuth,
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const photo = VisionMealInput.parse(req.body);
    if (decodedBytes(photo.image) > MAX_VISION_IMAGE_BYTES) {
      throw new HttpError(413, "image_too_large", `Photos up to ${MAX_VISION_IMAGE_BYTES} bytes`, {
        expose: true,
      });
    }
    const client = requireVisionClient();
    const userId = currentUser(res)._id;
    const reservation = await reservePhoto(userId);
    let items;
    try {
      items = await proposeItems(client, photo);
    } catch (err) {
      await refundPhoto(userId, reservation).catch((refundErr: unknown) =>
        console.error("[vision] refund failed:", refundErr),
      );
      throw err;
    }
    res.json(
      VisionMealResponse.parse({ items, remainingToday: VISION_DAILY_LIMIT - reservation.count }),
    );
  }),
);
