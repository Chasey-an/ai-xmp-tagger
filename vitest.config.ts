import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: [
      "tests/unit/**/*.test.ts",
      "tests/component/**/*.test.tsx",
    ],
    setupFiles: ["tests/setup.ts"],
  },
});
