import { Schema, model, type InferSchemaType } from "mongoose";
import { ALLERGEN_SOURCES, ALLERGEN_TIERS } from "@healtheat/shared";

// One entry of the allergen dictionary (design doc, Data model: Allergen; D12). Seeded from
// ALLERGEN_SEED (packages/shared) into an empty collection; Curator edits arrive with T21, and
// `updatedBy` is the Curator-to-Allergen one-to-many. Phrases are stored as written; the matcher
// (services/dictionary.ts) normalizes them.
const AllergenSchema = new Schema({
  key: { type: String, required: true, unique: true },
  displayName: { type: String, required: true },
  tier: { type: String, enum: ALLERGEN_TIERS, required: true },
  synonyms: { type: [String], default: [] },
  descriptionKeywords: { type: [String], default: [] },
  excludePhrases: { type: [String], default: [] },
  source: { type: String, enum: ALLERGEN_SOURCES, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  updatedAt: { type: Date, default: () => new Date() },
});

export type AllergenAttrs = InferSchemaType<typeof AllergenSchema>;
export const Allergen = model("Allergen", AllergenSchema);
