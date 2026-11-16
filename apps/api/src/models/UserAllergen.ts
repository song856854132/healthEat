import { Schema, model, type InferSchemaType } from "mongoose";
import { ALLERGEN_MODES } from "@healtheat/shared";

// User-to-Allergen many-to-many (design doc, Data model: UserAllergen): the allergens a member avoids
// (hard alert) or tracks (weekly exposure meter, with an optional threshold of hits per 7 days).
const UserAllergenSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  allergenId: { type: Schema.Types.ObjectId, ref: "Allergen", required: true },
  mode: { type: String, enum: ALLERGEN_MODES, required: true },
  weeklyThreshold: { type: Number, default: null, min: 1 },
});
UserAllergenSchema.index({ userId: 1, allergenId: 1 }, { unique: true });

export type UserAllergenAttrs = InferSchemaType<typeof UserAllergenSchema>;
export const UserAllergen = model("UserAllergen", UserAllergenSchema);
