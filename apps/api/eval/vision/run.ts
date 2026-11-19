import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError } from "../../src/lib/http.js";
import {
  SYSTEM_PROMPT,
  VISION_MODEL,
  proposeItems,
  visionClient,
} from "../../src/services/vision.js";
import { type EvalPhoto, type PhotoResult, gradePhoto, summarize } from "./grade.js";

// Vision eval (T18): send the 10 reference photos to the real photo pipeline once each and grade the
// answers against weighed grams. It spends money (about $0.15 a run, 10 calls, no retries), so it never
// runs in CI; run it by hand after any change to the photo prompt, model or output schema.
//
//   ANTHROPIC_API_KEY=... npm run eval:vision -w @healtheat/api            grade and print PASS or FAIL
//   ANTHROPIC_API_KEY=... npm run eval:vision -w @healtheat/api -- --record   also save the run as the baseline

type Baseline = {
  rule: string;
  photos: EvalPhoto[];
  recorded: null | {
    at: string;
    model: string;
    promptSha256: string;
    summary: ReturnType<typeof summarize>;
    photos: PhotoResult[];
  };
  [key: string]: unknown;
};

const here = dirname(fileURLToPath(import.meta.url));
const baselinePath = join(here, "baseline.json");

export const promptSha256 = () => createHash("sha256").update(SYSTEM_PROMPT).digest("hex");

async function main() {
  const record = process.argv.includes("--record");
  const client = visionClient();
  if (!client) {
    console.error("ANTHROPIC_API_KEY is not set; the eval calls Claude and cannot run without it.");
    process.exit(2);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
  const results: PhotoResult[] = [];
  for (const photo of baseline.photos) {
    const image = readFileSync(join(here, photo.file)).toString("base64");
    let result: PhotoResult;
    try {
      result = gradePhoto(photo, await proposeItems(client, { image, mediaType: "image/jpeg" }));
    } catch (err) {
      const code = err instanceof HttpError ? err.code : String(err);
      console.log(`${photo.id}  ERROR ${code}`);
      result = { ...gradePhoto(photo, []), extras: [`error: ${code}`] };
    }
    results.push(result);
    for (const i of result.items) {
      const ratio = i.ratio === null ? "missing" : `${i.ratio.toFixed(2)}x`;
      console.log(
        `${photo.id}  ${i.found ? "ok  " : "MISS"}  ${i.name}: weighed ${i.weighed} g, proposed ${i.proposed} g (${ratio})`,
      );
    }
    if (result.extras.length) console.log(`${photo.id}  extras: ${result.extras.join(", ")}`);
  }

  const summary = summarize(results);
  const prev = baseline.recorded;
  if (prev) {
    if (prev.promptSha256 !== promptSha256() || prev.model !== VISION_MODEL)
      console.log("note: the prompt or model changed since the recorded baseline");
    const was = new Set(
      prev.photos.flatMap((p) => p.items.filter((i) => i.found).map((i) => `${p.id} ${i.name}`)),
    );
    for (const r of results)
      for (const i of r.items)
        if (!i.found && was.has(`${r.id} ${i.name}`))
          console.log(`regression: ${r.id} ${i.name} was found in the baseline`);
  }
  console.log(
    `${summary.pass ? "PASS" : "FAIL"}: ${summary.found}/${summary.expected} items found (${Math.round(summary.share * 100)}%; ${baseline.rule})`,
  );
  if (record) {
    baseline.recorded = {
      at: new Date().toISOString(),
      model: VISION_MODEL,
      promptSha256: promptSha256(),
      summary,
      photos: results,
    };
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`recorded the run in ${baselinePath}`);
  }
  process.exit(summary.pass ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
