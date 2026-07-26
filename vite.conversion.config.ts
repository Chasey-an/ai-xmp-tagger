import { defineConfig } from "vite";

export default defineConfig({
  root: "tests/e2e/conversion-app",
  base: "./",
  build: {
    outDir: "../../../dist-conversion",
    emptyOutDir: true,
    target: "es2022",
  },
  optimizeDeps: {
    exclude: ["@jsquash/jpeg"],
  },
});
