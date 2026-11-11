import { defineConfig } from "@playwright/test";

// CI sets BASE_URL to the Vercel preview. Without it (a laptop, the pregate) Playwright starts the
// local stack in scripts/e2e/local-stack.mjs: in-memory MongoDB, API on 4000, web on 3000 with the
// rewrite pointing at that API. Set BASE_URL yourself to test an already-running stack or a deployment.
const baseURL = process.env.BASE_URL ?? "http://localhost:3000";
const localStack = process.env.BASE_URL
  ? undefined
  : {
      command: "node scripts/e2e/local-stack.mjs",
      url: `${baseURL}/api/health`, // through the rewrite: both servers are up when this answers
      timeout: 180_000,
      reuseExistingServer: true,
      stdout: "pipe" as const,
      stderr: "pipe" as const,
    };

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    // Local Ubuntu hosts with the AppArmor userns restriction cannot start Chromium's sandbox;
    // CI runners can. Set PW_NO_SANDBOX=1 locally if the browser fails to launch.
    chromiumSandbox: process.env.PW_NO_SANDBOX !== "1",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: localStack,
});
