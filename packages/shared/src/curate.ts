import { z } from "zod";

// The unmatched-ingredient queue (T22; design doc REST table, phase 3): ingredient phrases from cached
// foods that matched no allergen synonym, most frequent first, for a Curator to map or ignore.

export const TOKEN_STATUSES = ["new", "mapped", "ignored"] as const;
export const TokenStatus = z.enum(TOKEN_STATUSES);
export type TokenStatus = z.infer<typeof TokenStatus>;

/** Tokens per page of GET /api/curate/unmatched. */
export const UNMATCHED_PAGE_SIZE = 20;

export const UnmatchedQuery = z.object({
  status: TokenStatus.default("new"),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
export type UnmatchedQuery = z.infer<typeof UnmatchedQuery>;

export const UnmatchedTokenView = z.object({
  token: z.string(),
  /** Distinct cached foods whose ingredients carry this phrase. */
  count: z.number().int().min(0),
  sampleFdcIds: z.array(z.number().int()),
  status: TokenStatus,
  reviewedAt: z.string().datetime().nullable(),
});
export type UnmatchedTokenView = z.infer<typeof UnmatchedTokenView>;

export const UnmatchedListResponse = z.object({
  tokens: z.array(UnmatchedTokenView),
  page: z.number().int(),
  total: z.number().int(),
});
export type UnmatchedListResponse = z.infer<typeof UnmatchedListResponse>;

/** Body of PUT /api/curate/unmatched/:token: map the phrase to an allergen, or ignore it. */
export const UnmatchedActionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("map"), allergenId: z.string().regex(/^[a-f0-9]{24}$/i) }).strict(),
  z.object({ action: z.literal("ignore") }).strict(),
]);
export type UnmatchedActionInput = z.infer<typeof UnmatchedActionInput>;
