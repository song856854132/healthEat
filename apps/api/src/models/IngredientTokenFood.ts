import { Schema, model } from "mongoose";

// Which cached food carries which unmatched token (T22, eng review D2): the unique pair makes the
// token's count a count of distinct foods, however often a food is matched again.
const IngredientTokenFoodSchema = new Schema({
  token: { type: String, required: true },
  fdcId: { type: Number, required: true },
});
IngredientTokenFoodSchema.index({ token: 1, fdcId: 1 }, { unique: true });

export const IngredientTokenFood = model("IngredientTokenFood", IngredientTokenFoodSchema);
