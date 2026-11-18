import {
  UNMATCHED_PAGE_SIZE,
  type AllergenWriteResponse,
  type UnmatchedActionInput,
  type UnmatchedListResponse,
  type UnmatchedQuery,
  type UnmatchedTokenView,
} from "@healtheat/shared";
import type { Types } from "mongoose";
import { HttpError } from "../lib/http.js";
import { IngredientToken } from "../models/index.js";
import { addSynonym, normalize } from "./dictionary.js";

// The Curator's unmatched-ingredient queue (T22; design doc REST table, phase 3).

type StoredToken = {
  token: string;
  count: number;
  sampleFdcIds?: number[] | null;
  status: string;
  reviewedAt?: Date | null;
};

const view = (t: StoredToken): UnmatchedTokenView => ({
  token: t.token,
  count: t.count,
  sampleFdcIds: t.sampleFdcIds ?? [],
  status: t.status as UnmatchedTokenView["status"],
  reviewedAt: t.reviewedAt?.toISOString() ?? null,
});

/** GET /api/curate/unmatched: one status, most frequent first, 20 per page. */
export async function listUnmatched(query: UnmatchedQuery): Promise<UnmatchedListResponse> {
  const [tokens, total] = await Promise.all([
    IngredientToken.find({ status: query.status })
      .sort({ count: -1, token: 1 })
      .skip((query.page - 1) * UNMATCHED_PAGE_SIZE)
      .limit(UNMATCHED_PAGE_SIZE)
      .lean(),
    IngredientToken.countDocuments({ status: query.status }),
  ]);
  return { tokens: tokens.map(view), page: query.page, total };
}

/**
 * PUT /api/curate/unmatched/:token. `map` adds the phrase to the allergen's synonyms in one atomic
 * update (a concurrent edit of the allergen is never undone; 409 synonyms_full at the limit), runs the
 * allergen's re-match and marks the token mapped; `ignore` only marks it, and is refused (409
 * token_mapped) for a phrase already mapped. Returns the allergen write for a map (its re-match may be unfinished).
 */
export async function actOnToken(
  rawToken: string,
  input: UnmatchedActionInput,
  curatorId: Types.ObjectId,
): Promise<{ token: UnmatchedTokenView; write: AllergenWriteResponse | null }> {
  const token = normalize(rawToken);
  const stored = await IngredientToken.findOne({ token }).lean();
  if (!stored) throw new HttpError(404, "token_not_found");
  if (input.action === "ignore" && stored.status === "mapped")
    // The phrase is already in the dictionary: ignoring it here would misreport what the dictionary holds.
    throw new HttpError(409, "token_mapped", "this phrase is already mapped to an allergen");
  let write: AllergenWriteResponse | null = null;
  if (input.action === "map") write = await addSynonym(input.allergenId, token, curatorId);
  const updated = await IngredientToken.findOneAndUpdate(
    { token },
    {
      $set: {
        status: input.action === "map" ? "mapped" : "ignored",
        reviewedBy: curatorId,
        reviewedAt: new Date(),
      },
    },
    { new: true },
  ).lean();
  return { token: view(updated!), write };
}
