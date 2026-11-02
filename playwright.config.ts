import { defineConfig } from "@playwright/test";

const baseURL = process.env.BASE_URL ?? "http://localhost:3000";

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
});
