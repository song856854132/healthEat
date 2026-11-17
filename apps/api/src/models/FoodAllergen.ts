import { Schema, model, type InferSchemaType } from "mongoose";
import { MATCH_KINDS } from "@healtheat/shared";

// Food-to-Allergen many-to-many (design doc, Data model: FoodAllergen). One row per cached food and
// allergen it matched, rewritten whenever that food is matched again (fresh USDA copy, or a dictionary
// re-match in T5). The unique index also serves lookups by fdcId; the second serves per-allergen
// re-match and the Home feed's top allergens.
const FoodAllergenSchema = new Schema({
  fdcId: { type: Number, required: true },
  allergenId: { type: Schema.Types.ObjectId, ref: "Allergen", required: true },
  matchKind: { type: String, enum: MATCH_KINDS, required: true },
  matchedSynonym: { type: String, required: true },
  matchedAt: { type: Date, required: true },
});
FoodAllergenSchema.index({ fdcId: 1, allergenId: 1 }, { unique: true });
FoodAllergenSchema.index({ allergenId: 1, fdcId: 1 });

export type FoodAllergenAttrs = InferSchemaType<typeof FoodAllergenSchema>;
export const FoodAllergen = model("FoodAllergen", FoodAllergenSchema);
