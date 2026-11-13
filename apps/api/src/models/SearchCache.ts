import { Schema, model, type InferSchemaType } from "mongoose";

// One normalized USDA search page (design doc D5): shared by every function instance and kept across
// cold starts, so repeated searches do not spend the USDA quota (1,000 requests an hour per key). The
// TTL index deletes an entry 24 hours after it was written; services/usda.ts decides separately how
// long an entry counts as fresh.
export const SEARCH_CACHE_TTL_SECONDS = 24 * 60 * 60;

const SearchCacheSchema = new Schema({
  key: { type: String, required: true, unique: true, maxlength: 400 },
  payload: { type: Schema.Types.Mixed, required: true },
  createdAt: { type: Date, required: true, expires: SEARCH_CACHE_TTL_SECONDS },
});

export type SearchCacheAttrs = InferSchemaType<typeof SearchCacheSchema>;
export const SearchCache = model("SearchCache", SearchCacheSchema);
