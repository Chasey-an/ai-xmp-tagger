import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { validateReleaseManifest } from "../release-manifest.mjs";

const usage =
  "Usage: node scripts/assert-release-assets.mjs /absolute/path/to/dist";

async function sha256(filePath) {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

async function verifyAsset(distDirectory, asset) {
  const filePath = path.join(distDirectory, asset.filename);
  let fileStats;

  try {
    fileStats = await stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Missing release asset: ${filePath}`);
    }
    throw error;
  }

  if (!fileStats.isFile()) {
    throw new Error(`Release asset is not a file: ${filePath}`);
  }

  if (fileStats.size !== asset.bytes) {
    throw new Error(
      `Byte count mismatch for ${asset.filename}: expected ${asset.bytes}, got ${fileStats.size}`,
    );
  }

  const actualSha256 = await sha256(filePath);
  if (actualSha256 !== asset.sha256) {
    throw new Error(
      `SHA-256 mismatch for ${asset.filename}: expected ${asset.sha256}, got ${actualSha256}`,
    );
  }

  console.log(`verified ${asset.filename}`);
}

async function main() {
  const [distDirectory, ...extraArguments] = process.argv.slice(2);

  if (
    !distDirectory ||
    extraArguments.length > 0 ||
    !path.isAbsolute(distDirectory)
  ) {
    throw new Error(usage);
  }

  const manifest = validateReleaseManifest(
    JSON.parse(
      await readFile(new URL("../release.json", import.meta.url), "utf8"),
    ),
  );

  for (const asset of manifest.assets) {
    await verifyAsset(distDirectory, asset);
  }
}

main().catch((error) => {
  console.error(`Release asset verification failed: ${error.message}`);
  process.exitCode = 1;
});
