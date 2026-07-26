import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/conversion.spec.js",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:4174",
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
      "npm run build:conversion && vite preview --config vite.conversion.config.ts --host 127.0.0.1 --port 4174",
    url: "http://127.0.0.1:4174/",
    reuseExistingServer: false,
  },
});
