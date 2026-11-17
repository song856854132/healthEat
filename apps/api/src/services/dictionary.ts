import {
  ALLERGEN_SEED,
  type AllergenTier,
  type AllergenView,
  type FoodAllergenMatch,
  type MatchKind,
} from "@healtheat/shared";
import { Types } from "mongoose";
import { HttpError } from "../lib/http.js";
import { Allergen, DictionarySeed, Food, FoodAllergen, UserAllergen } from "../models/index.js";

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

/** Foods per re-match batch: one bulkWrite each (design doc, Re-match on dictionary change; S4). */
export const REMATCH_BATCH = 500;
/** A re-match stops after this long and reports `done: false`; the caller continues it later. */
export const REMATCH_BUDGET_MS = 60_000;

export type RematchResult = { done: boolean; processed: number; remaining: number };

const isDuplicate = (err: unknown) => (err as { code?: number }).code === 11000;

/** Starts (or restarts) the re-match of one allergen over every cached food: cursor 0 (R3-4). */
export async function startRematch(allergenId: Types.ObjectId): Promise<void> {
  const res = await Allergen.updateOne(
    { _id: allergenId },
    { $set: { rematchCursor: 0 }, $inc: { rematchRun: 1 } },
  );
  if (res.matchedCount === 0) throw new HttpError(404, "allergen_not_found");
}

/**
 * Re-matches one allergen over the cached foods, resuming from its `rematchCursor` (the next fdcId to
 * process; null when there is nothing left). Each batch of foods, in fdcId order, is one ordered
 * bulkWrite: delete this allergen's rows in the batch's fdcId range, then insert the new matches (D6, no
 * transaction). The cursor then moves past the batch only if neither it nor the run counter changed since
 * this batch read them, so an edit that restarted the re-match meanwhile is never overwritten (the counter
 * catches a restart during the first batch, when the cursor was already 0). A crash
 * between the write and the cursor update repeats that batch, which converges. Stops after `budgetMs`.
 */
export async function rematchAllergen(
  allergenId: Types.ObjectId,
  { batchSize = REMATCH_BATCH, budgetMs = REMATCH_BUDGET_MS, now = () => new Date() } = {},
): Promise<RematchResult> {
  const started = Date.now();
  let processed = 0;
  for (;;) {
    const doc = await Allergen.findById(allergenId).lean();
    if (!doc) throw new HttpError(404, "allergen_not_found");
    const cursor = doc.rematchCursor;
    const run = doc.rematchRun ?? 0;
    if (cursor === null || cursor === undefined) return { done: true, processed, remaining: 0 };

    const foods = await Food.find(
      { fdcId: { $gte: cursor } },
      { fdcId: 1, description: 1, ingredientsText: 1 },
    )
      .sort({ fdcId: 1 })
      .limit(batchSize)
      .lean();
    const last = foods.at(-1)?.fdcId;
    const next = foods.length < batchSize || last === undefined ? null : last + 1;
    if (foods.length > 0) {
      const entry = toEntry(doc);
      const matchedAt = now();
      const inserts = foods.flatMap((food) =>
        matchFood(food, [entry]).map((m) => ({
          insertOne: {
            document: {
              fdcId: food.fdcId,
              allergenId: entry.id,
              matchKind: m.matchKind,
              matchedSynonym: m.matchedSynonym,
              matchedAt,
            },
          },
        })),
      );
      try {
        await FoodAllergen.bulkWrite(
          [
            {
              deleteMany: { filter: { allergenId: entry.id, fdcId: { $gte: cursor, $lte: last } } },
            },
            ...inserts,
          ],
          { ordered: true },
        );
      } catch (err) {
        // Another request re-matched the same batch at the same time: re-read the cursor and go on.
        if (!isDuplicate(err)) throw err;
        continue;
      }
      processed += foods.length;
    }
    const moved = await Allergen.updateOne(
      { _id: allergenId, rematchCursor: cursor, rematchRun: run },
      { $set: { rematchCursor: next } },
    );
    // matchedCount 0: an edit restarted the re-match meanwhile, so the loop goes on from its cursor.
    if (moved.matchedCount === 0) continue;
    if (next === null) return { done: true, processed, remaining: 0 };
    if (Date.now() - started >= budgetMs) {
      const remaining = await Food.countDocuments({ fdcId: { $gte: next } });
      return { done: false, processed, remaining };
    }
  }
}

/**
 * DELETE /api/allergens/:id (R3-3): no matching pass. The allergen's FoodAllergen and UserAllergen rows
 * go first, then the entry, then its FoodAllergen rows once more, for a food matched by a concurrent
 * request while the entry still existed. Every step is rerunnable; a retry after a crash before the
 * entry was deleted finds it and finishes.
 */
export async function deleteAllergen(id: string): Promise<void> {
  if (!/^[a-f0-9]{24}$/i.test(id)) throw new HttpError(404, "allergen_not_found");
  const allergenId = new Types.ObjectId(id);
  if (!(await Allergen.exists({ _id: allergenId }))) throw new HttpError(404, "allergen_not_found");
  await FoodAllergen.deleteMany({ allergenId });
  await UserAllergen.deleteMany({ allergenId });
  await Allergen.deleteOne({ _id: allergenId });
  await FoodAllergen.deleteMany({ allergenId });
}
