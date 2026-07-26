import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: [
    "app.spec.ts",
    "network.spec.ts",
    "downloads.spec.ts",
    "csp.spec.ts",
  ],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chrome",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
      },
    },
    {
      name: "edge",
      use: {
        ...devices["Desktop Edge"],
        channel: "msedge",
      },
    },
  ],
  webServer: {
    command: "npm run build && node tests/e2e/serve-dist-csp.mjs",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
});
