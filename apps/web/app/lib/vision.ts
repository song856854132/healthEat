import { VISION_LIMIT_MESSAGE, VisionMealResponse } from "@healtheat/shared";
import type { VisionMealInput } from "@healtheat/shared";
import type { PhotoPrepProblem } from "./image";
import { jsonBody, request } from "./request";
import type { ApiFailure, ApiResult } from "./request";

// Photo logging's API call and what the page says about each outcome (apps/api/README.md: POST
// /api/vision/meal and its error rows). The photo only proposes foods and grams; the member confirms
// each one against a USDA food before anything is logged.

/** POST /api/vision/meal: up to 60 s on the server; never rejects unless `signal` aborted it. */
export function analyseMeal(
  input: VisionMealInput,
  signal?: AbortSignal,
): Promise<ApiResult<VisionMealResponse>> {
  return request("/api/vision/meal", VisionMealResponse, { ...jsonBody("POST", input), signal });
}

/** What went wrong, and which ways on the panel offers. */
export type PhotoProblem = {
  message: string;
  /** Send the same photo again. */
  retry: boolean;
  /** Pick another photo. */
  another: boolean;
  /** Link to logging the meal by search. */
  search: boolean;
  /** Link to the profile (the member profile must exist before photos are counted). */
  profile?: boolean;
};

/** The API's own sentence (its `details`), finished with a full stop, or null when it sent none. */
function sentence(details: unknown): string | null {
  if (typeof details !== "string" || !details.trim()) return null;
  const text = details.trim();
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;
}

export function visionProblem(failure: ApiFailure): PhotoProblem {
  switch (failure.error) {
    case "vision_limit":
      return {
        message: sentence(failure.details) ?? VISION_LIMIT_MESSAGE,
        retry: false,
        another: false,
        search: true,
      };
    case "vision_unavailable":
      // Not set up on this deployment, or the whole app reached today's photos: search still works.
      return {
        message: sentence(failure.details) ?? "Photo logging is not available right now.",
        retry: false,
        another: false,
        search: true,
      };
    case "vision_refused":
      return {
        message: "This photo could not be analysed. Log the meal by search instead.",
        retry: false,
        another: true,
        search: true,
      };
    case "vision_timeout":
      return {
        message: "The photo took too long to analyse. Try again.",
        retry: true,
        another: true,
        search: true,
      };
    case "vision_failed":
      return {
        message: "The photo could not be analysed. Try again.",
        retry: true,
        another: true,
        search: true,
      };
    case "image_too_large":
    case "payload_too_large":
      return prepProblem("too_large");
    case "member_profile_missing":
      return {
        // The profile is created by its first save, not by opening it (services/profiles.ts).
        message:
          "Save any detail on your profile once (your time zone, for example) so photos can be counted, then try again.",
        retry: true,
        another: false,
        search: false,
        profile: true,
      };
    case "validation_error":
      return {
        message: "This photo could not be sent. Choose another.",
        retry: false,
        another: true,
        search: true,
      };
    default:
      // A network failure, an unexpected answer, a session that ended: the message says which.
      return { message: failure.message, retry: true, another: true, search: true };
  }
}

/** The page gave up waiting (the server stops at 60 s; this is the browser's own limit). */
export const CLIENT_TIMEOUT: PhotoProblem = {
  message: "The photo took too long to analyse. Try again.",
  retry: true,
  another: true,
  search: true,
};

export function prepProblem(kind: PhotoPrepProblem): PhotoProblem {
  const message =
    kind === "not_image"
      ? "That file is not a photo. Choose a photo of the meal."
      : kind === "unreadable"
        ? "This browser cannot open that photo. Choose a JPEG or PNG, or take the photo again."
        : "This photo is too large to send, even made smaller. Choose another.";
  return { message, retry: false, another: true, search: true };
}

/** How sure the photo analysis was, in words: never a percentage, which would look more precise. */
export function confidenceWord(confidence: number): "likely" | "not sure" {
  return confidence >= 0.7 ? "likely" : "not sure";
}
