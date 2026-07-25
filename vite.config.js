import { readFile } from "node:fs/promises";
import { defineConfig } from "vite";
import {
  createReleaseTokens,
  injectReleaseTokens,
} from "./release-build.mjs";

const manifest = JSON.parse(
  await readFile(new URL("./release.json", import.meta.url), "utf8"),
);

const repository = process.env.GITHUB_REPOSITORY || "local/ai-xmp-tagger";
const tokens = createReleaseTokens(manifest, repository);

export default defineConfig({
  base: "./",
  plugins: [
    {
      name: "inject-release-downloads",
      transformIndexHtml: {
        order: "pre",
        handler(html) {
          return injectReleaseTokens(html, tokens);
        },
      },
    },
  ],
});
