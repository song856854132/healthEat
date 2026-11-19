import { Anthropic } from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { VisionItem, type VisionMealInput } from "@healtheat/shared";
import { z } from "zod";
import { env } from "../lib/env.js";
import { HttpError } from "../lib/http.js";

// Meal photo to proposed foods (T13; design doc, Photo pipeline and the vision amendment R3-17/R3-29).
// One Claude call per photo: structured output only, no nutrient numbers (USDA supplies those after the
// member confirms each item). The client never retries; the member's "Try again" is the retry, and the
// route refunds the day's photo count when this throws.

export const VISION_MODEL = "claude-opus-5-5";
/** A stuck call fails fast with a retryable error, well inside the function's 300 s window. */
export const VISION_TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT = `You look at a photo of a meal and list the foods you can see, so the user can log them.

For each distinct food, give:
- query: a short, plain name a person would type into the USDA FoodData Central search, such as "white rice, cooked" or "banana, raw". One food per item; split a plate into its parts.
- grams: your estimate of the portion in the photo, in grams.
- confidence: from 0 to 1, how sure you are about the food and the portion together.

Do not estimate calories, macronutrients, vitamins, minerals or allergens: the app looks those up from USDA after the user confirms each item. If the photo shows no food, return an empty list.`;

// What the model fills in. Range checks run after parsing (VisionItem), so an out-of-range item is
// dropped rather than failing the whole photo.
const ModelOutput = z.object({
  items: z.array(z.object({ query: z.string(), grams: z.number(), confidence: z.number() })),
});

type VisionClient = Pick<Anthropic, "beta">;
let clientOverride: VisionClient | null | undefined;

/** Tests only: replace the Anthropic client (null = no key configured). Pass undefined to reset. */
export function setVisionClientForTests(client: VisionClient | null | undefined) {
  clientOverride = client;
}

/** The configured client, or null when ANTHROPIC_API_KEY is unset. */
export function visionClient(): VisionClient | null {
  if (clientOverride !== undefined) return clientOverride;
  const apiKey = env().ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new Anthropic({ apiKey, timeout: VISION_TIMEOUT_MS, maxRetries: 0 });
}

/** 503 when photo logging is not configured on this deployment; checked before a photo is counted. */
export function requireVisionClient(): VisionClient {
  const client = visionClient();
  if (!client)
    throw new HttpError(503, "vision_unavailable", "Photo logging is not available right now", {
      expose: true,
    });
  return client;
}

/**
 * Ask Claude for the foods in one photo. Throws HttpError: 504 vision_timeout, 422 vision_refused (the
 * whole fallback chain declined), 502 vision_failed (any other upstream or parsing failure).
 */
export async function proposeItems(
  client: VisionClient,
  photo: VisionMealInput,
): Promise<VisionItem[]> {
  let response;
  try {
    response = await client.beta.messages.parse({
      model: VISION_MODEL,
      // About 20 items fit in a few hundred tokens; the rest is room for low-effort thinking. A cut answer
      // is a 502 and a refunded photo, never a partial list.
      max_tokens: 2000,
      // A declined photo is retried server-side on the model Anthropic recommends for that refusal
      // category; the switch is logged below, never shown to the member.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: betaZodOutputFormat(ModelOutput) },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: photo.mediaType, data: photo.image },
            },
            { type: "text", text: "List the foods in this meal." },
          ],
        },
      ],
    });
  } catch (err) {
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      throw new HttpError(504, "vision_timeout", "The photo took too long to analyse; try again", {
        expose: true,
      });
    }
    if (err instanceof Anthropic.APIError) {
      console.error(`[vision] upstream error ${err.status ?? "connection"}: ${err.message}`);
      throw new HttpError(502, "vision_failed", "The photo could not be analysed; try again", {
        expose: true,
      });
    }
    // The SDK parses the structured output inside parse(): a refusal that came back with text, or an
    // answer cut off at max_tokens, throws its base AnthropicError rather than returning.
    if (err instanceof Anthropic.AnthropicError) {
      console.error(`[vision] unusable answer: ${err.message}`);
      throw new HttpError(502, "vision_failed", "The photo could not be analysed; try again", {
        expose: true,
      });
    }
    throw err;
  }

  for (const block of response.content) {
    if (block.type === "fallback")
      console.info(`[vision] ${block.from.model} declined; ${block.to.model} answered`);
  }
  if (response.stop_reason === "refusal") {
    console.warn(`[vision] refused: ${response.stop_details?.category ?? "unknown"}`);
    throw new HttpError(
      422,
      "vision_refused",
      "This photo could not be analysed; log the meal by search",
    );
  }
  const parsed = response.parsed_output;
  if (!parsed) {
    console.error(`[vision] no structured output (stop_reason ${response.stop_reason})`);
    throw new HttpError(502, "vision_failed", "The photo could not be analysed; try again", {
      expose: true,
    });
  }
  return parsed.items.flatMap((item) => {
    const ok = VisionItem.safeParse({ ...item, query: item.query.trim() });
    return ok.success ? [ok.data] : [];
  });
}
