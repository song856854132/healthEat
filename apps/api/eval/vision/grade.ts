import type { VisionItem } from "@healtheat/shared";

// Grading for the vision eval (T18; design doc: "10 reference photos, baseline JSON, items present and
// grams within 2x"). Pure functions, so the rule is unit tested without calling Claude.

export type ExpectedItem = {
  /** The ingredient as the source dataset names it. */
  name: string;
  /** Weighed grams on the plate (Nutrition5k scale data). */
  grams: number;
  /** Lowercase fragments; a proposed query containing any of them names this item. */
  match: string[];
};

export type EvalPhoto = { id: string; file: string; expected: ExpectedItem[] };

export type ItemResult = {
  name: string;
  weighed: number;
  proposed: number;
  ratio: number | null;
  found: boolean;
};

export type PhotoResult = { id: string; items: ItemResult[]; extras: string[] };

/** The grams a match may be off by, either way: within 2x of the weighed amount. */
export const GRAMS_FACTOR = 2;
/** The eval passes when at least this share of all expected items is found. */
export const PASS_SHARE = 0.9;

/**
 * Grade one photo. Each proposed item counts toward the first expected item it names (so "strawberries"
 * and "raspberries" both add to "berries"); an item naming none is an extra, reported but not failed. An
 * expected item is found when its proposed grams add up to within GRAMS_FACTOR of the weighed grams.
 */
export function gradePhoto(photo: EvalPhoto, proposed: readonly VisionItem[]): PhotoResult {
  const totals = photo.expected.map(() => 0);
  const named = photo.expected.map(() => false);
  const extras: string[] = [];
  for (const item of proposed) {
    const query = item.query.toLowerCase();
    const at = photo.expected.findIndex((e) => e.match.some((m) => query.includes(m)));
    if (at === -1) {
      extras.push(item.query);
      continue;
    }
    totals[at] += item.grams;
    named[at] = true;
  }
  const items = photo.expected.map((e, i) => {
    const ratio = named[i] ? totals[i] / e.grams : null;
    const found = ratio !== null && ratio >= 1 / GRAMS_FACTOR && ratio <= GRAMS_FACTOR;
    return { name: e.name, weighed: e.grams, proposed: totals[i], ratio, found };
  });
  return { id: photo.id, items, extras };
}

export type EvalSummary = { found: number; expected: number; share: number; pass: boolean };

/** The eval's verdict over every photo. A photo that failed to answer counts all its items as missed. */
export function summarize(results: readonly PhotoResult[]): EvalSummary {
  const all = results.flatMap((r) => r.items);
  const found = all.filter((i) => i.found).length;
  const share = all.length ? found / all.length : 0;
  return { found, expected: all.length, share, pass: all.length > 0 && share >= PASS_SHARE };
}
