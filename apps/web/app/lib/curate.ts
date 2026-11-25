import {
  AllergenListResponse,
  AllergenWriteResponse,
  CuratorProfileView,
  RematchProgress,
  UnmatchedListResponse,
} from "@healtheat/shared";
import type {
  AllergenCreateInput,
  AllergenTier,
  AllergenUpdateInput,
  CuratorProfileInput,
} from "@healtheat/shared";
import { NO_BODY, jsonBody, request } from "./request";
import type { ApiFailure, ApiResult } from "./request";

// Browser-side calls for the Curator pages (T21 web half; apps/api/README.md, REST table): the allergen
// dictionary, continuing a re-match, the unmatched queue's size and the Curator's own profile.

/** How each tier reads on the pages (design doc, Data model: Allergen; D12). */
export const TIER_LABELS: Record<AllergenTier, string> = {
  allergy: "Allergy",
  sensitivity: "Sensitivity",
  both: "Allergy or sensitivity",
};

export function allergenHref(key: string): string {
  return `/curate/allergens/${encodeURIComponent(key)}`;
}

// apps/api/README.md, error table: the dictionary routes' own errors.
const MESSAGES: Record<string, string> = {
  allergen_not_found: "This allergen no longer exists; another Curator may have deleted it.",
  conflict: "An allergen with this key already exists.",
  forbidden: "Only Curators can change the allergen dictionary.",
};

/** GET /api/allergens: the whole dictionary, ordered by display name (public). */
export function listAllergens(signal?: AbortSignal): Promise<ApiResult<AllergenListResponse>> {
  return request("/api/allergens", AllergenListResponse, { signal });
}

/** POST /api/allergens: 201 with the re-match done, 202 while foods are left. */
export function createAllergen(
  input: AllergenCreateInput,
): Promise<ApiResult<AllergenWriteResponse>> {
  return request("/api/allergens", AllergenWriteResponse, jsonBody("POST", input), MESSAGES);
}

/** PUT /api/allergens/:id: every editable field; 200 with the re-match done, 202 while foods are left. */
export function updateAllergen(
  id: string,
  input: AllergenUpdateInput,
): Promise<ApiResult<AllergenWriteResponse>> {
  return request(
    `/api/allergens/${encodeURIComponent(id)}`,
    AllergenWriteResponse,
    jsonBody("PUT", input),
    MESSAGES,
  );
}

/** DELETE /api/allergens/:id: 204, or 409 allergen_avoided while any member avoids it. */
export function deleteAllergen(id: string): Promise<ApiResult<null>> {
  return request(
    `/api/allergens/${encodeURIComponent(id)}`,
    NO_BODY,
    { method: "DELETE" },
    MESSAGES,
  );
}

/** "3 members avoid …": the 409 allergen_avoided answer says how many, never who. */
export function deleteRefusal(failure: ApiFailure): string {
  if (failure.error !== "allergen_avoided") return failure.message;
  const n = (failure.details as { members?: unknown } | undefined)?.members;
  const who =
    typeof n === "number"
      ? `${n} member${n === 1 ? " avoids" : "s avoid"} this allergen`
      : "Members avoid this allergen";
  return `${who}, so deleting it would silently drop their alerts. Nothing was deleted. Rename or edit the entry instead.`;
}

/** POST /api/curate/allergens/:id/rematch: 200 when done, 202 while foods are left. */
export function continueRematch(id: string): Promise<ApiResult<RematchProgress>> {
  return request(
    `/api/curate/allergens/${encodeURIComponent(id)}/rematch`,
    RematchProgress,
    jsonBody("POST"),
    MESSAGES,
  );
}

/** GET /api/curate/unmatched?status=new: the queue's first page; only its `total` is shown before T22's page. */
export function unmatchedQueue(signal?: AbortSignal): Promise<ApiResult<UnmatchedListResponse>> {
  return request("/api/curate/unmatched?status=new", UnmatchedListResponse, { signal });
}

/** GET /api/users/me/profiles/curator. */
export function getCuratorProfile(signal?: AbortSignal): Promise<ApiResult<CuratorProfileView>> {
  return request("/api/users/me/profiles/curator", CuratorProfileView, { signal });
}

/** PUT /api/users/me/profiles/curator: absent fields stay, `null` clears. */
export function updateCuratorProfile(
  input: CuratorProfileInput,
): Promise<ApiResult<CuratorProfileView>> {
  return request("/api/users/me/profiles/curator", CuratorProfileView, jsonBody("PUT", input));
}

/**
 * The phrases of a list field as the Curator typed them: one per line or comma-separated, trimmed,
 * blanks dropped, and repeats (ignoring case) kept once. Commas never occur inside a phrase: the
 * matcher splits a label's ingredients on them.
 */
export function parsePhrases(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const phrase = raw.trim().replace(/\s+/g, " ");
    if (!phrase || seen.has(phrase.toLowerCase())) continue;
    seen.add(phrase.toLowerCase());
    out.push(phrase);
  }
  return out;
}
