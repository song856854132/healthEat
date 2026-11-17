import { Schema, model } from "mongoose";

// Which ALLERGEN_SEED keys have already been written into the dictionary (one document, _id "allergens").
// A seed key missing from `keys` is upserted on the next read, so a partial or failed first seed and a
// seed entry added in a later release both reach the database; a key listed here that a Curator deleted
// stays deleted (services/dictionary.ts).
const DictionarySeedSchema = new Schema({
  _id: { type: String, required: true },
  keys: { type: [String], default: [] },
});

export const DictionarySeed = model("DictionarySeed", DictionarySeedSchema);
