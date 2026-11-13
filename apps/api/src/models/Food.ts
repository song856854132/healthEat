import { Schema, model, type InferSchemaType } from "mongoose";

// Cache of the USDA foods people open (design doc, Data model: Food). Kept, not expired: log entries
// and allergen matches will point at these documents, so a stale one is re-fetched (after
// FOOD_REFRESH_DAYS, services/usda.ts) rather than deleted.
const NutrientSchema = new Schema(
  {
    nutrientId: { type: Number, required: true },
    name: { type: String, required: true },
    unit: { type: String, required: true },
    amountPer100g: { type: Number, required: true },
  },
  { _id: false },
);

const ServingSizeSchema = new Schema(
  { label: { type: String, required: true }, grams: { type: Number, required: true, min: 0 } },
  { _id: false },
);

const FoodSchema = new Schema({
  fdcId: { type: Number, required: true, unique: true },
  description: { type: String, required: true },
  dataType: { type: String, required: true },
  brandOwner: { type: String, default: null },
  ingredientsText: { type: String, default: null },
  nutrients: { type: [NutrientSchema], default: [] },
  servingSizes: { type: [ServingSizeSchema], default: [] },
  fetchedAt: { type: Date, required: true },
});

export type FoodAttrs = InferSchemaType<typeof FoodSchema>;
export const Food = model("Food", FoodSchema);
