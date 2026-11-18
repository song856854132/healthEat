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
import { Allergen, IngredientToken } from "../models/index.js";
import { normalize, updateAllergen } from "./dictionary.js";

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
 * PUT /api/curate/unmatched/:token. `map` appends the phrase to the allergen's synonyms through the
 * ordinary Curator edit (so the allergen's re-match runs and the edit counts), then marks the token
 * mapped; `ignore` only marks it. Returns the allergen write for a map (its re-match may be unfinished).
 */
export async function actOnToken(
  rawToken: string,
  input: UnmatchedActionInput,
  curatorId: Types.ObjectId,
): Promise<{ token: UnmatchedTokenView; write: AllergenWriteResponse | null }> {
  const token = normalize(rawToken);
  const stored = await IngredientToken.findOne({ token }).lean();
  if (!stored) throw new HttpError(404, "token_not_found");
  let write: AllergenWriteResponse | null = null;
  if (input.action === "map") {
    const allergen = await Allergen.findById(input.allergenId).lean();
    if (!allergen) throw new HttpError(404, "allergen_not_found");
    const synonyms = allergen.synonyms ?? [];
    write = await updateAllergen(
      input.allergenId,
      {
        displayName: allergen.displayName,
        tier: allergen.tier as never,
        synonyms: synonyms.some((s) => normalize(s) === token) ? synonyms : [...synonyms, token],
        descriptionKeywords: allergen.descriptionKeywords ?? [],
        excludePhrases: allergen.excludePhrases ?? [],
      },
      curatorId,
    );
  }
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
