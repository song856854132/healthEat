import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "api",
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 120_000,
    // Each worker owns one in-memory MongoDB; keep files isolated.
    fileParallelism: true,
  },
});
