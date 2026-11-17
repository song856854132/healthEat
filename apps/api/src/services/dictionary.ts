import {
  ALLERGEN_SEED,
  type AllergenTier,
  type AllergenView,
  type FoodAllergenMatch,
  type MatchKind,
} from "@healtheat/shared";
import type { Types } from "mongoose";
import { Allergen, DictionarySeed, Food, FoodAllergen } from "../models/index.js";

// Allergen dictionary and matcher (design doc: Allergen matching, D12). The matcher is plain string
// work so it can run over a whole batch of cached foods in one request (T5 re-match).

/** Lowercase, accents dropped, every run of non-alphanumerics one space: "Soy-Lécithine" -> "soy lecithine". */
export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * One normalized entry per ingredient of a label: split at commas, semicolons, colons, periods and
 * brackets, so "emulsifier (soy lecithin)" gives "emulsifier" and "soy lecithin", and a phrase never
 * spans two ingredients.
 */
export function ingredientSegments(ingredientsText: string): string[] {
  return ingredientsText
    .split(/[,;:.()[\]{}]+/)
    .map(normalize)
    .filter((s) => s.length > 0);
}

type Phrase = { raw: string; norm: string };
export type DictionaryEntry = {
  id: Types.ObjectId;
  key: string;
  displayName: string;
  tier: AllergenTier;
  synonyms: string[];
  descriptionKeywords: string[];
  excludePhrases: string[];
};
type Compiled = {
  entry: DictionaryEntry;
  synonyms: Phrase[];
  keywords: Phrase[];
  excludes: string[];
};

// Longest first, so the reported synonym is the most specific one ("soy lecithin", not "soy").
const phrases = (list: string[]): Phrase[] =>
  list
    .map((raw) => ({ raw, norm: normalize(raw) }))
    .filter((p) => p.norm.length > 0)
    .sort((a, b) => b.norm.length - a.norm.length);

const compile = (entry: DictionaryEntry): Compiled => ({
  entry,
  synonyms: phrases(entry.synonyms),
  keywords: phrases(entry.descriptionKeywords),
  excludes: phrases(entry.excludePhrases).map((p) => p.norm),
});

/** Hides every exclude phrase from the text, so its words cannot match ("cocoa butter" is not milk). */
function mask(padded: string, excludes: string[]): string {
  let out = padded;
  for (const ex of excludes) {
    const needle = ` ${ex} `;
    while (out.includes(needle)) out = out.replace(needle, " ~ ");
  }
  return out;
}

const firstMatch = (padded: string, list: Phrase[]): Phrase | undefined =>
  list.find((p) => padded.includes(` ${p.norm} `));

export type Match = { entry: DictionaryEntry; matchKind: MatchKind; matchedSynonym: string };

/**
 * Allergens one food matches. Ingredient text is searched for synonyms, one ingredient at a time. The
 * description is searched for description keywords when the food has no ingredient text (Foundation,
 * SR Legacy and Survey foods), and for sensitivity-tier allergens on every food (D12). An ingredient
 * match wins over a description match for the same allergen.
 */
export function matchFood(
  food: { description: string; ingredientsText?: string | null },
  dictionary: DictionaryEntry[],
): Match[] {
  const segments = food.ingredientsText ? ingredientSegments(food.ingredientsText) : [];
  const description = ` ${normalize(food.description)} `;
  const out: Match[] = [];
  for (const c of dictionary.map(compile)) {
    let hit: Match | undefined;
    for (const seg of segments) {
      const p = firstMatch(mask(` ${seg} `, c.excludes), c.synonyms);
      if (p) {
        hit = { entry: c.entry, matchKind: "ingredient", matchedSynonym: p.raw };
        break;
      }
    }
    if (!hit && (segments.length === 0 || c.entry.tier === "sensitivity")) {
      const p = firstMatch(mask(description, c.excludes), c.keywords);
      if (p) hit = { entry: c.entry, matchKind: "description", matchedSynonym: p.raw };
    }
    if (hit) out.push(hit);
  }
  return out;
}

const byName = (a: { displayName: string }, b: { displayName: string }) =>
  a.displayName.localeCompare(b.displayName, "en");

const toEntry = (doc: {
  _id: Types.ObjectId;
  key: string;
  displayName: string;
  tier: string;
  synonyms?: string[] | null;
  descriptionKeywords?: string[] | null;
  excludePhrases?: string[] | null;
}): DictionaryEntry => ({
  id: doc._id,
  key: doc.key,
  displayName: doc.displayName,
  tier: doc.tier as AllergenTier,
  synonyms: doc.synonyms ?? [],
  descriptionKeywords: doc.descriptionKeywords ?? [],
  excludePhrases: doc.excludePhrases ?? [],
});

const SEED_MARKER = "allergens";

/**
 * The stored dictionary documents. Every ALLERGEN_SEED key not yet recorded in the DictionarySeed marker is
 * upserted first ($setOnInsert: an existing entry, a Curator's edit, is never overwritten), and only then
 * recorded. So a new database is seeded, a seed that failed partway is finished on the next read, two first
 * reads both wait for the full seed, and an entry added to the seed later reaches existing databases; a seed
 * entry a Curator deleted is listed in the marker and stays deleted.
 */
async function dictionaryDocs() {
  const marker = await DictionarySeed.findById(SEED_MARKER).lean();
  const seeded = new Set(marker?.keys ?? []);
  const missing = ALLERGEN_SEED.filter((a) => !seeded.has(a.key));
  if (missing.length > 0) {
    await Allergen.bulkWrite(
      missing.map((a) => ({
        updateOne: {
          filter: { key: a.key },
          update: { $setOnInsert: { ...a, source: "seed", updatedBy: null } },
          upsert: true,
        },
      })),
      { ordered: false },
    ).catch((err: unknown) => {
      // Two first reads upserting the same key: one insert wins, the other's is a duplicate.
      if ((err as { code?: number }).code !== 11000) throw err;
    });
    await DictionarySeed.updateOne(
      { _id: SEED_MARKER },
      { $addToSet: { keys: { $each: missing.map((a) => a.key) } } },
      { upsert: true },
    ).catch((err: unknown) => {
      if ((err as { code?: number }).code !== 11000) throw err;
    });
  }
  return Allergen.find().lean();
}

/** The dictionary in matcher form, ordered by display name. */
export async function loadDictionary(): Promise<DictionaryEntry[]> {
  return (await dictionaryDocs()).map(toEntry).sort(byName);
}

/** GET /api/allergens: the whole dictionary, ordered by display name. */
export async function listAllergens(): Promise<AllergenView[]> {
  return (await dictionaryDocs())
    .map((d) => {
      const { key, displayName, tier, synonyms, descriptionKeywords, excludePhrases } = toEntry(d);
      return {
        id: String(d._id),
        key,
        displayName,
        tier,
        synonyms,
        descriptionKeywords,
        excludePhrases,
        source: d.source as AllergenView["source"],
      };
    })
    .sort(byName);
}

const view = (m: Match): FoodAllergenMatch => ({
  key: m.entry.key,
  displayName: m.entry.displayName,
  tier: m.entry.tier,
  matchKind: m.matchKind,
  matchedSynonym: m.matchedSynonym,
});

type MatchableFood = {
  fdcId: number;
  description: string;
  ingredientsText?: string | null;
  fetchedAt: Date;
  allergensMatchedAt?: Date | null;
};

/**
 * Matches one cached food against the dictionary and replaces its FoodAllergen rows: one ordered
 * bulkWrite (delete that food's rows, insert the new ones), then the food is stamped matched. No
 * transaction (D6): a crash between the two leaves the stamp unset, and the next read matches again.
 * A failed write is logged and the computed matches are still returned.
 */
export async function matchAndStore(
  food: MatchableFood,
  now = new Date(),
): Promise<FoodAllergenMatch[]> {
  const matches = matchFood(food, await loadDictionary());
  try {
    // A newer USDA copy stored meanwhile is matched by its own request: this stale match writes nothing,
    // so it cannot replace that copy's rows (the check narrows the race to the write itself).
    if (!(await Food.exists({ fdcId: food.fdcId, fetchedAt: food.fetchedAt })))
      return matches.map(view).sort(byName);
    await FoodAllergen.bulkWrite(
      [
        { deleteMany: { filter: { fdcId: food.fdcId } } },
        ...matches.map((m) => ({
          insertOne: {
            document: {
              fdcId: food.fdcId,
              allergenId: m.entry.id,
              matchKind: m.matchKind,
              matchedSynonym: m.matchedSynonym,
              matchedAt: now,
            },
          },
        })),
      ],
      { ordered: true },
    );
    // Only the copy that was matched: a newer USDA copy written meanwhile keeps its own null stamp.
    await Food.updateOne(
      { fdcId: food.fdcId, fetchedAt: food.fetchedAt },
      { $set: { allergensMatchedAt: now } },
    );
  } catch (err) {
    // A concurrent match of the same food inserted the same rows first (duplicate key): it stamps them.
    if ((err as { code?: number }).code !== 11000)
      console.error(
        "[dictionary] storing matches for %d failed:",
        food.fdcId,
        err instanceof Error ? err.message : err,
      );
  }
  return matches.map(view).sort(byName);
}

/** A food's detected allergens: its stored rows, or a fresh match when it has none yet. */
export async function allergensForFood(food: MatchableFood): Promise<FoodAllergenMatch[]> {
  if (!food.allergensMatchedAt) return matchAndStore(food);
  const rows = await FoodAllergen.find({ fdcId: food.fdcId }).lean();
  if (rows.length === 0) return [];
  const entries = await Allergen.find({ _id: { $in: rows.map((r) => r.allergenId) } }).lean();
  const byId = new Map(entries.map((e) => [String(e._id), toEntry(e)]));
  return rows
    .flatMap((r) => {
      const entry = byId.get(String(r.allergenId));
      // An allergen deleted since the match (its rows go with it in T5) is simply not shown.
      return entry
        ? [view({ entry, matchKind: r.matchKind as MatchKind, matchedSynonym: r.matchedSynonym })]
        : [];
    })
    .sort(byName);
}
