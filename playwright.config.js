import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.js",
  testIgnore: "**/e2e/conversion.spec.js",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command:
      "npm run build && node tests/e2e/serve-dist-csp.mjs",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
});
