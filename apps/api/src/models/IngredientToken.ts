import { Schema, model } from "mongoose";
import { TOKEN_STATUSES } from "@healtheat/shared";

// One normalised ingredient phrase that matched no allergen synonym (T22; design doc Data model,
// phase 3). `count` is the number of distinct cached foods carrying it, kept exact by the unique
// IngredientTokenFood join (eng review D2). Curator to IngredientToken is one-to-many (`reviewedBy`).
const IngredientTokenSchema = new Schema({
  token: { type: String, required: true, unique: true },
  count: { type: Number, required: true, default: 0, min: 0 },
  sampleFdcIds: { type: [Number], default: [] },
  status: { type: String, enum: TOKEN_STATUSES, default: "new" },
  reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  reviewedAt: { type: Date, default: null },
});
// The queue: one status, most frequent first, ties by phrase (design doc P2 index; the sort uses it).
IngredientTokenSchema.index({ status: 1, count: -1, token: 1 });

export const IngredientToken = model("IngredientToken", IngredientTokenSchema);
