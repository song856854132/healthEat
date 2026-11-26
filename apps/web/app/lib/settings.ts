import { UserAllergensResponse } from "@healtheat/shared";
import type { UserAllergensInput } from "@healtheat/shared";
import { jsonBody, request } from "./request";
import type { ApiFailure, ApiResult } from "./request";

// The member's own settings on /profile (T31; apps/api/README.md: GET/PUT /api/users/me/allergens). The
// body details and calorie band go through GET/PUT /api/users/me/profiles/member (lib/account.ts).

const MESSAGES: Record<string, string> = {
  forbidden: "Only members have allergen settings.",
};

/** GET /api/users/me/allergens: the member's avoid and track list, ordered by display name. */
export function getMyAllergens(signal?: AbortSignal): Promise<ApiResult<UserAllergensResponse>> {
  return request("/api/users/me/allergens", UserAllergensResponse, { signal }, MESSAGES);
}

/** PUT /api/users/me/allergens: the complete list; it replaces the stored one. */
export function setMyAllergens(
  input: UserAllergensInput,
): Promise<ApiResult<UserAllergensResponse>> {
  return request(
    "/api/users/me/allergens",
    UserAllergensResponse,
    jsonBody("PUT", input),
    MESSAGES,
  );
}

/** 400 unknown_allergen names the keys the dictionary lost while the member was choosing. */
export function allergenSaveError(failure: ApiFailure): string {
  if (failure.error !== "unknown_allergen") return failure.message;
  const keys = (failure.details as { keys?: unknown } | undefined)?.keys;
  const named = Array.isArray(keys) && keys.length ? ` (${keys.join(", ")})` : "";
  return `The dictionary changed while you were choosing: some allergens${named} no longer exist. Nothing was saved. Reload the page and choose again.`;
}
