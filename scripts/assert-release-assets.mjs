import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateReleaseManifest } from "../release-manifest.mjs";

const usage =
  "Usage: node scripts/assert-release-assets.mjs /absolute/path/to/dist";

export async function sha256File(filePath) {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

export async function verifyAsset(
  distDirectory,
  asset,
  output = console,
) {
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

  const actualSha256 = await sha256File(filePath);
  if (actualSha256 !== asset.sha256) {
    throw new Error(
      `SHA-256 mismatch for ${asset.filename}: expected ${asset.sha256}, got ${actualSha256}`,
    );
  }

  output.log(`verified ${asset.filename}`);
}

export function parseDistDirectoryArgument(argumentsList) {
  const [distDirectory, ...extraArguments] = argumentsList;

  if (
    !distDirectory ||
    extraArguments.length > 0 ||
    !path.isAbsolute(distDirectory)
  ) {
    throw new Error(usage);
  }

  return distDirectory;
}

export async function verifyReleaseAssets(
  distDirectory,
  unvalidatedManifest,
  output = console,
) {
  const manifest = validateReleaseManifest(unvalidatedManifest);

  for (const asset of manifest.assets) {
    await verifyAsset(distDirectory, asset, output);
  }
}

export async function runCli(
  argumentsList = process.argv.slice(2),
  output = console,
) {
  const distDirectory = parseDistDirectoryArgument(argumentsList);
  const manifest = JSON.parse(
    await readFile(new URL("../release.json", import.meta.url), "utf8"),
  );

  await verifyReleaseAssets(distDirectory, manifest, output);
}

const isMainModule =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  runCli().catch((error) => {
    console.error(`Release asset verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
