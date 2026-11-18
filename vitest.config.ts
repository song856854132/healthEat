import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/shared", "apps/api"],
    // T15 coverage gate (eng review D13), on with `vitest run --coverage` (CI runs it): the summary
    // maths stays at 100% branches; the allergen matcher may not fall below its measured baseline
    // (94.2% of branches on 2026-11-18). Its uncovered branches are write-error, race and retry paths
    // (duplicate-key catches, a re-match run that moved, a token write failure, an allergen deleted
    // mid-edit) and one unreachable `?? []` in allergensForFood; none decides what a food matches.
    coverage: {
      provider: "v8",
      include: ["apps/api/src/services/summary.ts", "apps/api/src/services/dictionary.ts"],
      reporter: ["text"],
      thresholds: {
        "apps/api/src/services/summary.ts": { branches: 100, statements: 100, functions: 100 },
        "apps/api/src/services/dictionary.ts": { branches: 94, statements: 99, functions: 100 },
      },
    },
  },
});
