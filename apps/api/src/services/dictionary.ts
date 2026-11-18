import {
  ALLERGEN_SEED,
  type AllergenCreateInput,
  type AllergenTier,
  type AllergenUpdateInput,
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

/**
 * Which dictionary a match ran against: every entry's id with its `rematchRun`. A Curator add, edit or
 * delete changes it (an add or edit bumps `rematchRun`, T5/T21), so a match can tell afterwards that the
 * dictionary moved while it ran.
 */
const versionOf = (docs: { _id: Types.ObjectId; rematchRun?: number | null }[]) =>
  docs
    .map((d) => `${String(d._id)}:${d.rematchRun ?? 0}`)
    .sort()
    .join(",");

const currentVersion = async () =>
  versionOf(await Allergen.find({}, { _id: 1, rematchRun: 1 }).lean());

type StoredAllergen = Parameters<typeof toEntry>[0] & {
  source: string;
  rematchCursor?: number | null;
};

function allergenView(d: StoredAllergen): AllergenView {
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
    rematchPending: d.rematchCursor !== null && d.rematchCursor !== undefined,
  };
}

/** GET /api/allergens: the whole dictionary, ordered by display name. */
export async function listAllergens(): Promise<AllergenView[]> {
  return (await dictionaryDocs()).map(allergenView).sort(byName);
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

/** Most matches of one food against a dictionary that keeps changing under it before giving up. */
const MATCH_ATTEMPTS = 2;

/**
 * Matches one cached food against the dictionary and replaces its FoodAllergen rows: one ordered
 * bulkWrite (delete that food's rows, insert the new ones), then the food is stamped matched. No
 * transaction (D6): a crash between the two leaves the stamp unset, and the next read matches again.
 * A failed write is logged and the computed matches are still returned.
 *
 * A Curator edit can land while this runs: its re-match may pass this food before this write, which
 * then replaces the new rows with matches from the old dictionary. So the dictionary version is read
 * again after the write; if it moved, the food is matched once more against the new one. If it moves
 * again, the food is left unstamped and the next read matches it.
 */
export async function matchAndStore(
  food: MatchableFood,
  now = new Date(),
): Promise<FoodAllergenMatch[]> {
  let matches: Match[] = [];
  for (let attempt = 1; attempt <= MATCH_ATTEMPTS; attempt++) {
    const docs = await dictionaryDocs();
    const version = versionOf(docs);
    matches = matchFood(food, docs.map(toEntry).sort(byName));
    try {
      // A newer USDA copy stored meanwhile is matched by its own request: this stale match writes
      // nothing, so it cannot replace that copy's rows (the check narrows the race to the write itself).
      if (!(await Food.exists({ fdcId: food.fdcId, fetchedAt: food.fetchedAt }))) break;
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
      if ((await currentVersion()) !== version) continue; // the dictionary moved: match again
      // Only the copy that was matched: a newer USDA copy written meanwhile keeps its own null stamp.
      await Food.updateOne(
        { fdcId: food.fdcId, fetchedAt: food.fetchedAt },
        { $set: { allergensMatchedAt: now } },
      );
      break;
    } catch (err) {
      // A concurrent match of the same food inserted the same rows first (duplicate key): it stamps them.
      if ((err as { code?: number }).code !== 11000)
        console.error(
          "[dictionary] storing matches for %d failed:",
          food.fdcId,
          err instanceof Error ? err.message : err,
        );
      break;
    }
  }
  return matches.map(view).sort(byName);
}

/** A food's detected allergens: its stored rows, or a fresh match when it has none yet. */
export async function allergensForFood(food: MatchableFood): Promise<FoodAllergenMatch[]> {
  return (await allergensForFoods([food])).get(food.fdcId) ?? [];
}

/**
 * Detected allergens of many foods at once (T25, eng review D7): one FoodAllergen read and one Allergen
 * read for every stamped food, and a fresh `matchAndStore` for each food not stamped yet. Each list is
 * ordered by display name. An allergen deleted since the match (its rows go with it in T5) is not shown.
 */
export async function allergensForFoods(
  foods: MatchableFood[],
): Promise<Map<number, FoodAllergenMatch[]>> {
  const out = new Map<number, FoodAllergenMatch[]>();
  const stamped = foods.filter((f) => f.allergensMatchedAt);
  for (const food of foods)
    if (!food.allergensMatchedAt) out.set(food.fdcId, await matchAndStore(food));
  if (stamped.length === 0) return out;
  const rows = await FoodAllergen.find({ fdcId: { $in: stamped.map((f) => f.fdcId) } }).lean();
  const ids = [...new Set(rows.map((r) => String(r.allergenId)))];
  const entries = ids.length > 0 ? await Allergen.find({ _id: { $in: ids } }).lean() : [];
  const byId = new Map(entries.map((e) => [String(e._id), toEntry(e)]));
  for (const food of stamped) out.set(food.fdcId, []);
  for (const r of rows) {
    const entry = byId.get(String(r.allergenId));
    if (!entry) continue;
    out
      .get(r.fdcId)
      ?.push(
        view({ entry, matchKind: r.matchKind as MatchKind, matchedSynonym: r.matchedSynonym }),
      );
  }
  for (const list of out.values()) list.sort(byName);
  return out;
}

/** Foods per re-match batch: one bulkWrite each (design doc, Re-match on dictionary change; S4). */
export const REMATCH_BATCH = 500;
/** A re-match stops after this long and reports `done: false`; the caller continues it later. */
export const REMATCH_BUDGET_MS = 60_000;

export type RematchResult = { done: boolean; processed: number; remaining: number };

const isDuplicate = (err: unknown) => (err as { code?: number }).code === 11000;

type BatchFood = {
  fdcId: number;
  description: string;
  ingredientsText?: string | null;
  fetchedAt: Date;
};
const BATCH_FIELDS = { fdcId: 1, description: 1, ingredientsText: 1, fetchedAt: 1 };

/**
 * Which USDA copy a food holds: its `fetchedAt` as JSON, so a Date compares by time and a malformed value
 * (written past the schema) by its own content, never throwing and never equal to a different one.
 */
const copyKey = (d: unknown) => JSON.stringify(d ?? null);

/** The fdcIds of `batch` whose USDA copy is not the one in `copies` (a newer copy, or none). */
function movedFoods(batch: BatchFood[], copies: { fdcId: number; fetchedAt?: unknown }[]) {
  const now = new Map(copies.map((c) => [c.fdcId, copyKey(c.fetchedAt)]));
  return batch
    .filter((f) => !now.has(f.fdcId) || now.get(f.fdcId) !== copyKey(f.fetchedAt))
    .map((f) => f.fdcId);
}

/**
 * One ordered bulkWrite: delete this allergen's rows for the foods in `fdcIds`, then insert the matches of
 * `foods` against `entry`. Only those foods: a food cached and matched by another request after the
 * batch read keeps its row, which that request matched against the current dictionary.
 */
async function writeBatch(
  entry: DictionaryEntry,
  fdcIds: number[],
  foods: BatchFood[],
  matchedAt: Date,
) {
  await FoodAllergen.bulkWrite(
    [
      { deleteMany: { filter: { allergenId: entry.id, fdcId: { $in: fdcIds } } } },
      ...foods.flatMap((food) =>
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
      ),
    ],
    { ordered: true },
  );
}

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
 * bulkWrite: delete this allergen's rows for the foods the batch read, then insert the new matches (D6, no
 * transaction). The cursor then moves past the batch only if neither it nor the run counter changed since
 * this batch read them, so an edit that restarted the re-match meanwhile is never overwritten (the counter
 * catches a restart during the first batch, when the cursor was already 0). A crash
 * between the write and the cursor update repeats that batch, which converges. Stops after `budgetMs`.
 *
 * A batch's write can land late, after a newer edit's pass or a food's USDA refresh already rewrote those
 * foods, and replace their rows with matches from the old entry or the old ingredient text. So after the
 * write the batch reads the run counter and the foods' `fetchedAt` again (only those two fields, so a
 * batch where nothing moved reads little); if either moved, it writes the batch once more from the newer
 * entry and copies. If they move again, the foods that may hold stale rows are left unstamped (the whole
 * batch after a newer edit, only the refreshed foods otherwise), so the next read of each matches it
 * whole against the current dictionary. A batch whose write stops at a concurrent writer's duplicate key
 * leaves its foods unstamped, then repeats from the cursor, and stops at the time budget like any other.
 */
export async function rematchAllergen(
  allergenId: Types.ObjectId,
  { batchSize = REMATCH_BATCH, budgetMs = REMATCH_BUDGET_MS, now = () => new Date() } = {},
): Promise<RematchResult> {
  const started = Date.now();
  let processed = 0;
  for (;;) {
    const doc = await Allergen.findById(allergenId).lean();
    if (!doc) {
      // Deleted while this pass ran: drop any rows a batch wrote after the delete's own sweep.
      await FoodAllergen.deleteMany({ allergenId });
      throw new HttpError(404, "allergen_not_found");
    }
    const cursor = doc.rematchCursor;
    const run = doc.rematchRun ?? 0;
    if (cursor === null || cursor === undefined) return { done: true, processed, remaining: 0 };

    const foods: BatchFood[] = await Food.find({ fdcId: { $gte: cursor } }, BATCH_FIELDS)
      .sort({ fdcId: 1 })
      .limit(batchSize)
      .lean();
    const last = foods.at(-1)?.fdcId;
    const next = foods.length < batchSize || last === undefined ? null : last + 1;
    if (foods.length > 0) {
      const fdcIds = foods.map((f) => f.fdcId);
      try {
        let current = doc;
        let batch = foods;
        for (let attempt = 1; ; attempt++) {
          await writeBatch(toEntry(current), fdcIds, batch, now());
          const after = await Allergen.findById(allergenId).lean();
          if (!after) break; // deleted meanwhile: the next read of the entry sweeps its rows
          const copies = await Food.find(
            { fdcId: { $in: fdcIds } },
            { fdcId: 1, fetchedAt: 1 },
          ).lean();
          const runMoved = (after.rematchRun ?? 0) !== (current.rematchRun ?? 0);
          const moved = movedFoods(batch, copies);
          if (!runMoved && moved.length === 0) break;
          if (attempt === MATCH_ATTEMPTS) {
            await Food.updateMany(
              { fdcId: { $in: runMoved ? fdcIds : moved } },
              { $set: { allergensMatchedAt: null } },
            );
            break;
          }
          // A newer edit or USDA copy landed meanwhile: write the batch again from it.
          current = after;
          batch = await Food.find({ fdcId: { $in: fdcIds } }, BATCH_FIELDS)
            .sort({ fdcId: 1 })
            .lean();
        }
      } catch (err) {
        // Another request re-matched the same batch at the same time: re-read the cursor and go on,
        // unless the time budget is spent.
        if (!isDuplicate(err)) throw err;
        // The ordered write stopped at a row another writer had just inserted: this batch's later inserts
        // never ran, and that writer (another batch, or one food's matchAndStore) may cover only its own
        // food. The batch cannot vouch for its foods' rows, and a repeat below can be skipped by another
        // pass moving the cursor first, so its foods are left unstamped: the next read of each matches it
        // whole. Collisions are rare, so the cost is a few extra matches.
        await Food.updateMany({ fdcId: { $in: fdcIds } }, { $set: { allergensMatchedAt: null } });
        if (Date.now() - started >= budgetMs) {
          const remaining = await Food.countDocuments({ fdcId: { $gte: cursor } });
          return { done: false, processed, remaining };
        }
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

/** An allergen id from a URL; anything that is not an ObjectId names no allergen. */
const objectId = (id: string) => {
  if (!/^[a-f0-9]{24}$/i.test(id)) throw new HttpError(404, "allergen_not_found");
  return new Types.ObjectId(id);
};

/**
 * DELETE /api/allergens/:id (R3-3): no matching pass. The allergen's FoodAllergen and UserAllergen rows
 * go first, then the entry, then its FoodAllergen rows once more, for a food matched by a concurrent
 * request while the entry still existed. Every step is rerunnable: a retry finishes the job, and a
 * retry after the entry is already gone still sweeps its rows before answering 404.
 */
export async function deleteAllergen(id: string): Promise<void> {
  const allergenId = objectId(id);
  const existed = (await Allergen.exists({ _id: allergenId })) !== null;
  await FoodAllergen.deleteMany({ allergenId });
  await UserAllergen.deleteMany({ allergenId });
  if (!existed) throw new HttpError(404, "allergen_not_found"); // rows left by a crash are gone now
  await Allergen.deleteOne({ _id: allergenId });
  await FoodAllergen.deleteMany({ allergenId });
}

export type AllergenWrite = { allergen: AllergenView; rematch: RematchResult };

/**
 * Re-matches a just-written allergen inside the write's own request (design doc, Re-match on dictionary
 * change), then reads the entry back so the answer shows whether foods are still left.
 */
async function rematchAfterWrite(
  id: Types.ObjectId,
  opts?: Parameters<typeof rematchAllergen>[1],
): Promise<AllergenWrite> {
  const rematch = await rematchAllergen(id, opts);
  const doc = await Allergen.findById(id).lean();
  if (!doc) throw new HttpError(404, "allergen_not_found"); // deleted by another Curator meanwhile
  return { allergen: allergenView(doc), rematch };
}

/**
 * POST /api/allergens (curator): a new entry, written by `curatorId`, with its re-match started in the
 * same insert (cursor 0) so no food can be skipped if the request dies before the first batch. A key that
 * already exists, including a seed key, is the driver's duplicate key error, answered 409 conflict.
 */
export async function createAllergen(
  input: AllergenCreateInput,
  curatorId: Types.ObjectId,
  opts?: Parameters<typeof rematchAllergen>[1],
): Promise<AllergenWrite> {
  await dictionaryDocs(); // seed first, so a new entry never takes a seed key the seed has not written yet
  const doc = await Allergen.create({
    ...input,
    source: "curator",
    updatedBy: curatorId,
    updatedAt: new Date(),
    rematchCursor: 0,
    rematchRun: 1,
  });
  return rematchAfterWrite(doc._id, opts);
}

/**
 * PUT /api/allergens/:id (curator): replaces every editable field and restarts the re-match in the same
 * update, so a crash after the write leaves the entry flagged `rematchPending` rather than stale. Every
 * edit restarts it, even one that only renames the entry: the pass is cheap (D6), and deciding from a
 * read made before the write would race a concurrent edit. The entry's source becomes "curator".
 */
export async function updateAllergen(
  id: string,
  input: AllergenUpdateInput,
  curatorId: Types.ObjectId,
  opts?: Parameters<typeof rematchAllergen>[1],
): Promise<AllergenWrite> {
  const allergenId = objectId(id);
  const res = await Allergen.updateOne(
    { _id: allergenId },
    {
      $set: {
        ...input,
        source: "curator",
        updatedBy: curatorId,
        updatedAt: new Date(),
        rematchCursor: 0,
      },
      $inc: { rematchRun: 1 },
    },
    { runValidators: true },
  );
  if (res.matchedCount === 0) throw new HttpError(404, "allergen_not_found");
  return rematchAfterWrite(allergenId, opts);
}

/** POST /api/curate/allergens/:id/rematch (curator): continues an unfinished re-match from its cursor. */
export async function continueRematch(
  id: string,
  opts?: Parameters<typeof rematchAllergen>[1],
): Promise<RematchResult> {
  return rematchAllergen(objectId(id), opts);
}
