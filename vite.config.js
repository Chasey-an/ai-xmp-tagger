import { readFile } from "node:fs/promises";
import { defineConfig } from "vite";

const manifest = JSON.parse(
  await readFile(new URL("./release.json", import.meta.url), "utf8"),
);

function requireAsset(platform) {
  const asset = manifest.assets?.find(
    (candidate) => candidate.platform === platform,
  );

  if (!asset) {
    throw new Error(
      `release.json is missing the required "${platform}" release asset`,
    );
  }

  return asset;
}

function parseRepository(value) {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/.exec(
    value,
  );

  if (!match || match[2] === "." || match[2] === "..") {
    throw new Error(
      `Invalid GITHUB_REPOSITORY "${value}"; expected an owner/repository value`,
    );
  }

  return { owner: match[1], name: match[2] };
}

function formatMebibytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const repository = process.env.GITHUB_REPOSITORY || "local/ai-xmp-tagger";
const { owner, name } = parseRepository(repository);
const releasesUrl = `https://github.com/${owner}/${name}/releases`;
const assetDownloadRoot = `${releasesUrl}/download/${manifest.tag}`;
const canonicalUrl = `https://${owner}.github.io/${name}/`;

const macArm64 = requireAsset("mac-arm64");
const macX64 = requireAsset("mac-x64");
const windowsX64 = requireAsset("windows-x64");

const tokens = {
  VERSION: manifest.version,
  RELEASES_URL: releasesUrl,
  MAC_ARM64_URL: `${assetDownloadRoot}/${macArm64.filename}`,
  MAC_ARM64_SIZE: formatMebibytes(macArm64.bytes),
  MAC_ARM64_SHA: macArm64.sha256,
  MAC_X64_URL: `${assetDownloadRoot}/${macX64.filename}`,
  MAC_X64_SIZE: formatMebibytes(macX64.bytes),
  MAC_X64_SHA: macX64.sha256,
  WINDOWS_X64_URL: `${assetDownloadRoot}/${windowsX64.filename}`,
  WINDOWS_X64_SIZE: formatMebibytes(windowsX64.bytes),
  WINDOWS_X64_SHA: windowsX64.sha256,
  CANONICAL_URL: canonicalUrl,
};

function injectReleaseTokens(html) {
  return html.replace(/@@([A-Z0-9_]+)@@/g, (placeholder, token) => {
    if (!Object.hasOwn(tokens, token)) {
      throw new Error(`No build-time value is defined for HTML token ${placeholder}`);
    }

    return tokens[token];
  });
}

export default defineConfig({
  base: "./",
  plugins: [
    {
      name: "inject-release-downloads",
      apply: "build",
      transformIndexHtml: {
        order: "pre",
        handler: injectReleaseTokens,
      },
    },
  ],
});
