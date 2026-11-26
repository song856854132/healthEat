import {
  AllergenListResponse,
  AllergenWriteResponse,
  CuratorProfileView,
  RematchProgress,
  TOKEN_STATUSES,
  UnmatchedListResponse,
  UnmatchedTokenView,
} from "@healtheat/shared";
import type {
  AllergenCreateInput,
  AllergenTier,
  AllergenUpdateInput,
  CuratorProfileInput,
  TokenStatus,
  UnmatchedActionInput,
} from "@healtheat/shared";
import { NO_BODY, jsonBody, request } from "./request";
import type { ApiFailure, ApiResult } from "./request";

// Browser-side calls for the Curator pages (T21 and T22 web halves; apps/api/README.md, REST table): the
// allergen dictionary, continuing a re-match, the unmatched-ingredient queue and the Curator's own profile.

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

/** The unmatched queue's state as /curate/unmatched?status=&page= carries it. */
export type UnmatchedPageQuery = { status: TokenStatus; page: number };

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Reads the queue's URL leniently: an unknown status or a bad page shows the new phrases, page 1. */
export function readUnmatchedQuery(params: Params): UnmatchedPageQuery {
  const status = TOKEN_STATUSES.find((s) => s === first(params.status)) ?? "new";
  const n = Number(first(params.page));
  // The API's UnmatchedQuery allows pages up to 1000.
  const page = Number.isInteger(n) && n >= 1 ? Math.min(n, 1000) : 1;
  return { status, page };
}

function unmatchedQs({ status, page }: UnmatchedPageQuery): string {
  const sp = new URLSearchParams();
  if (status !== "new") sp.set("status", status);
  if (page > 1) sp.set("page", String(page));
  return sp.toString();
}

/** The /curate/unmatched URL for this state; the new phrases and page 1 are left out. */
export function unmatchedHref(query: UnmatchedPageQuery): string {
  const qs = unmatchedQs(query);
  return qs ? `/curate/unmatched?${qs}` : "/curate/unmatched";
}

/** GET /api/curate/unmatched?status=&page=: 20 phrases a page, most foods first. */
export function listUnmatched(
  query: UnmatchedPageQuery,
  signal?: AbortSignal,
): Promise<ApiResult<UnmatchedListResponse>> {
  const sp = new URLSearchParams({ status: query.status, page: String(query.page) });
  return request(`/api/curate/unmatched?${sp.toString()}`, UnmatchedListResponse, { signal });
}

/** GET /api/curate/unmatched?status=new: the queue's first page; Curator Home shows its `total`. */
export function unmatchedQueue(signal?: AbortSignal): Promise<ApiResult<UnmatchedListResponse>> {
  return listUnmatched({ status: "new", page: 1 }, signal);
}

/** Answer of PUT /api/curate/unmatched/:token: the token as stored now, and the allergen write for a map. */
export type UnmatchedActionResult = {
  token: UnmatchedTokenView;
  write: AllergenWriteResponse | null;
};

// The API's own response schema is not exported from @healtheat/shared, so it is put together here from
// the two shapes it is made of (apps/api/src/routes/curate.ts, ActionResponse).
const UnmatchedActionResponse = {
  safeParse(v: unknown): { success: true; data: UnmatchedActionResult } | { success: false } {
    const body = (v ?? {}) as { token?: unknown; write?: unknown };
    const token = UnmatchedTokenView.safeParse(body.token);
    if (!token.success) return { success: false };
    if (body.write === null) return { success: true, data: { token: token.data, write: null } };
    const write = AllergenWriteResponse.safeParse(body.write);
    return write.success
      ? { success: true, data: { token: token.data, write: write.data } }
      : { success: false };
  },
};

// apps/api/README.md, error table: the queue action's own errors.
const UNMATCHED_MESSAGES: Record<string, string> = {
  token_not_found: "This phrase is no longer in the queue. Reload the list.",
  allergen_not_found:
    "That allergen no longer exists; another Curator may have deleted it. Reload the list.",
  token_excluded:
    "That allergen’s exclude phrases hide this phrase, so it could never match. Pick another allergen, or edit its exclude phrases first.",
  synonyms_full:
    "That allergen already holds 200 synonyms, the most an entry can have. Nothing was changed.",
  token_mapped: "This phrase is already mapped to an allergen, so it cannot be ignored.",
  forbidden: "Only Curators can review the unmatched ingredients.",
};

/**
 * PUT /api/curate/unmatched/:token: map the phrase to an allergen (a dictionary edit: 200 with its
 * re-match done, 202 while foods are left) or ignore it (200).
 */
export function actOnUnmatched(
  token: string,
  input: UnmatchedActionInput,
): Promise<ApiResult<UnmatchedActionResult>> {
  return request(
    `/api/curate/unmatched/${encodeURIComponent(token)}`,
    UnmatchedActionResponse,
    jsonBody("PUT", input),
    UNMATCHED_MESSAGES,
  );
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
