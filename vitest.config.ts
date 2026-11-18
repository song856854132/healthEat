import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/shared", "apps/api"],
    // T15 coverage gate (eng review D13), on with `vitest run --coverage` (CI runs it): the summary
    // maths stays at 100% branches; the allergen matcher may not fall below its measured baseline
    // (92.7% of branches on 2026-11-18; the uncovered ones are an index-creation retry and a
    // seed-race duplicate, not matching logic).
    coverage: {
      provider: "v8",
      include: ["apps/api/src/services/summary.ts", "apps/api/src/services/dictionary.ts"],
      reporter: ["text"],
      thresholds: {
        "apps/api/src/services/summary.ts": { branches: 100, statements: 100, functions: 100 },
        "apps/api/src/services/dictionary.ts": { branches: 92, statements: 99, functions: 100 },
      },
    },
  },
});
