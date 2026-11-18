import { z } from "zod";
import { MAX_LOG_GRAMS } from "./logs.js";

// Photo logging (T13; design doc, Photo pipeline and the vision amendment). The photo is an input method,
// not the data source: Claude proposes foods and grams, the member confirms each one through a USDA
// search, and USDA supplies the nutrients. Nothing is saved by the vision call itself.

/** Photos a member may analyse per local day; the 21st call is 429 `vision_limit`. */
export const VISION_DAILY_LIMIT = 20;
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
