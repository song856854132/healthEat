import { Schema, model, type InferSchemaType } from "mongoose";
import { ALLERGEN_SOURCES, ALLERGEN_TIERS } from "@healtheat/shared";

// One entry of the allergen dictionary (design doc, Data model: Allergen; D12). Seeded from
// ALLERGEN_SEED (packages/shared): every seed key not yet recorded in the DictionarySeed marker is
// upserted on read, so a seed entry a Curator deleted stays deleted. Curator edits arrive with T21, and
// `updatedBy` is the Curator-to-Allergen one-to-many. Phrases are stored as written; the matcher
// (services/dictionary.ts) normalizes them. `rematchCursor` is the next cached fdcId a re-match after an
// edit still has to process (0 when it starts, null when it is done; R3-4, T5). `rematchRun` counts the
// starts, so a batch of an older run can tell that an edit restarted the re-match even at cursor 0.
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
  rematchCursor: { type: Number, default: null, min: 0 },
  rematchRun: { type: Number, default: 0, min: 0 },
});

export type AllergenAttrs = InferSchemaType<typeof AllergenSchema>;
export const Allergen = model("Allergen", AllergenSchema);
