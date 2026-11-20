import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MAX_VISION_IMAGE_BYTES } from "@healtheat/shared";
import { describe, expect, it } from "vitest";
import { VISION_MODEL } from "../src/services/vision.js";
import {
  type EvalPhoto,
  GRAMS_FACTOR,
  type PhotoResult,
  PASS_SHARE,
  gradePhoto,
  summarize,
} from "../eval/vision/grade.js";
import { promptSha256 } from "../eval/vision/run.js";

const photo: EvalPhoto = {
  id: "dish",
  file: "photos/dish.jpg",
  expected: [
    { name: "berries", grams: 60, match: ["berr"] },
    { name: "scrambled eggs", grams: 100, match: ["egg"] },
  ],
};
const item = (query: string, grams: number) => ({ query, grams, confidence: 0.9 });

describe("vision eval grading", () => {
  // Value: protects=the T18 pass rule "items present and grams within 2x" is applied as written, at both
  //   edges; fails_when=the factor or its comparison changes; why_new=T18; seam=none; no_claim=model quality
  it("finds an item at exactly half or twice its weighed grams and misses it just outside", () => {
    const at = (grams: number) =>
      gradePhoto(photo, [item("scrambled eggs", grams)]).items[1]!.found;
    expect(GRAMS_FACTOR).toBe(2);
    expect([at(50), at(200), at(49), at(201)]).toEqual([true, true, false, false]);
  });

  // Value: protects=a split answer ("strawberries" + "raspberries") counts toward one expected item, and
  //   unnamed items are reported as extras, not failures; fails_when=matching takes only the first item or
  //   fails on extras; why_new=T18; seam=none; no_claim=none
  it("adds up every proposed item that names an expected item and lists the rest as extras", () => {
    const r = gradePhoto(photo, [
      item("Strawberries", 20),
      item("raspberries", 15),
      item("toast", 30),
    ]);
    expect(r.items[0]).toMatchObject({ proposed: 35, found: true });
    expect(r.items[1]).toMatchObject({ proposed: 0, ratio: null, found: false });
    expect(r.extras).toEqual(["toast"]);
  });

  // Value: protects=the eval verdict needs 90% of all expected items, and an empty run never passes;
  //   fails_when=the threshold or its rounding changes; why_new=T18; seam=none; no_claim=none
  it("passes at 90% of expected items found and not below", () => {
    const run = (found: number, of: number) =>
      summarize([
        {
          id: "x",
          extras: [],
          items: Array.from({ length: of }, (_, i) => ({
            name: `i${i}`,
            weighed: 1,
            proposed: 1,
            ratio: 1,
            found: i < found,
          })),
        },
      ]).pass;
    expect(PASS_SHARE).toBe(0.9);
    expect([run(9, 10), run(8, 10), run(21, 23), run(20, 23), summarize([]).pass]).toEqual([
      true,
      false,
      true,
      false,
      false,
    ]);
  });
});

describe("vision eval baseline", () => {
  const dir = join(__dirname, "../eval/vision");
  const baseline = JSON.parse(readFileSync(join(dir, "baseline.json"), "utf8")) as {
    photos: EvalPhoto[];
    recorded: {
      model: string;
      promptSha256: string;
      summary: ReturnType<typeof summarize>;
      photos: PhotoResult[];
    } | null;
  };

  // Value: protects=every reference photo exists and is small enough for the route's own size cap, so
  //   the eval measures the pipeline members use; fails_when=a photo is missing, renamed or oversized;
  //   why_new=T18; seam=none; no_claim=model quality
  it("has 10 photos within the route's size cap, each with weighed items", () => {
    expect(baseline.photos).toHaveLength(10);
    for (const p of baseline.photos) {
      expect(statSync(join(dir, p.file)).size).toBeLessThanOrEqual(MAX_VISION_IMAGE_BYTES);
      expect(p.expected.length).toBeGreaterThan(0);
      for (const e of p.expected) {
        expect(e.grams).toBeGreaterThan(0);
        expect(e.match.every((m) => m === m.toLowerCase() && m.length > 0)).toBe(true);
      }
    }
  });

  // Value: protects=the rule that a photo prompt or model change reruns the paid eval: the recorded
  //   baseline must be a passing run of the prompt and model the app sends today; fails_when=SYSTEM_PROMPT
  //   or VISION_MODEL changes without `npm run eval:vision -- --record`; why_new=T18; seam=none;
  //   no_claim=model quality (only the recorded run measures that). Extended: protects=the recorded run
  //   graded the same photos and weighed items the eval uses today, and its summary is what the rule
  //   gives; fails_when=expected grams, items or photos are edited without re-recording
  it("was recorded as a passing run of today's photo prompt, model, photos and weights", () => {
    expect(baseline.recorded).toMatchObject({
      model: VISION_MODEL,
      promptSha256: promptSha256(),
      summary: { pass: true },
    });
    const recorded = baseline.recorded!;
    expect(
      recorded.photos.map((r) => ({ id: r.id, items: r.items.map((i) => [i.name, i.weighed]) })),
    ).toEqual(
      baseline.photos.map((p) => ({ id: p.id, items: p.expected.map((e) => [e.name, e.grams]) })),
    );
    expect(summarize(recorded.photos)).toEqual(recorded.summary);
  });
});
