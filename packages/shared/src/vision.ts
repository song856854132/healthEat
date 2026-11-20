import { z } from "zod";
import { MAX_LOG_GRAMS } from "./logs.js";

// Photo logging (T13; design doc, Photo pipeline and the vision amendment). The photo is an input method,
// not the data source: Claude proposes foods and grams, the member confirms each one through a USDA
// search, and USDA supplies the nutrients. Nothing is saved by the vision call itself.

/** Photos a member may analyse per local day; the 21st call is 429 `vision_limit`. */
export const VISION_DAILY_LIMIT = 20;
/**
 * Failed calls refunded per member per day (amendment R3-29: failures do not use up a photo). Anthropic
 * still bills a refused, timed-out or unparseable call, so refunds stop here: from the 11th failure on,
 * a failed photo counts. A member's photo calls per day are therefore at most 20 + 10; a declined photo
 * can also bill the server-side fallback model's run, so one call can cost two model runs.
 */
export const VISION_DAILY_REFUNDS = 10;
/**
 * Photo calls the whole app makes per UTC day, across all members. Open registration multiplies the
 * per-member caps, so this is the app's own spend ceiling: at roughly $0.10 worst case per call (input,
 * max_tokens of output, and a fallback model's run when a photo is declined) it keeps a day under about
 * $30. Reaching it answers 503 vision_unavailable until the UTC day turns.
 */
export const VISION_APP_DAILY_LIMIT = 300;
/** Message the web shows on the 21st photo (design doc, REST table). */
export const VISION_LIMIT_MESSAGE = "Photo limit reached for today (20). Text search is unlimited.";
/**
 * Largest decoded image the route accepts. The browser downsizes to a 1024 px JPEG (typically under
 * 250 KB); the 1 MB JSON body limit allows about 750 KB of base64-decoded bytes.
 */
export const MAX_VISION_IMAGE_BYTES = 700_000;

export const VISION_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/** Body of POST /api/vision/meal: one photo, base64 without a data: prefix. */
export const VisionMealInput = z.strictObject({
  image: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "base64 without a data: prefix"),
  mediaType: z.enum(VISION_MEDIA_TYPES),
});
export type VisionMealInput = z.infer<typeof VisionMealInput>;

/** One food Claude sees: a USDA search phrase, an estimated portion and how sure it is. */
export const VisionItem = z.object({
  query: z.string().min(1).max(80),
  grams: z.number().positive().max(MAX_LOG_GRAMS),
  confidence: z.number().min(0).max(1),
});
export type VisionItem = z.infer<typeof VisionItem>;

/** 200 answer: the proposed items (possibly none) and the photos left today. */
export const VisionMealResponse = z.object({
  items: z.array(VisionItem),
  remainingToday: z.number().int().min(0).max(VISION_DAILY_LIMIT),
});
export type VisionMealResponse = z.infer<typeof VisionMealResponse>;
