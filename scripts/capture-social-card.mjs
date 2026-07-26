import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

export const CAPTURE_CONTRACT = Object.freeze({
  version: 1,
  platform: "darwin",
  width: 1200,
  height: 630,
  deviceScaleFactor: 1,
  playwrightVersion: "1.61.1",
  font:
    '"PingFang SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
});

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
const sourceUrl = new URL("../social-card.html", import.meta.url);
const committedOutputPath = path.join(
  projectDirectory,
  "public/images/social-card.png",
);
const lockPath = path.join(projectDirectory, "social-card.lock.json");
const lockedRelativePaths = [
  "social-card.html",
  "public/images/browser-workbench.png",
  "scripts/capture-social-card.mjs",
  "public/images/social-card.png",
];

function temporarySiblingPath(targetPath) {
  return `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

export function validateSocialCardPng(png) {
  assert.ok(png.length > 20_000, "social card PNG is unexpectedly small");
  assert.equal(
    png.subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
    "social card output must be a PNG",
  );
  assert.equal(
    png.readUInt32BE(16),
    CAPTURE_CONTRACT.width,
    `social card width must be ${CAPTURE_CONTRACT.width}`,
  );
  assert.equal(
    png.readUInt32BE(20),
    CAPTURE_CONTRACT.height,
    `social card height must be ${CAPTURE_CONTRACT.height}`,
  );
}

async function validateSocialCardFile(filePath) {
  const [png, outputStat] = await Promise.all([
    readFile(filePath),
    stat(filePath),
  ]);
  assert.ok(outputStat.isFile(), "social card output must be a regular file");
  validateSocialCardPng(png);
  return { bytes: outputStat.size, sha256: await sha256File(filePath) };
}

export async function installValidatedPng(temporaryPath, outputPath) {
  await validateSocialCardFile(temporaryPath);
  await rename(temporaryPath, outputPath);
}

async function renderSocialCard(outputPath) {
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: {
        width: CAPTURE_CONTRACT.width,
        height: CAPTURE_CONTRACT.height,
      },
      deviceScaleFactor: CAPTURE_CONTRACT.deviceScaleFactor,
    });
    const page = await context.newPage();

    await page.goto(sourceUrl.href, { waitUntil: "load" });
    const readiness = await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        [...document.images].map((image) => {
          if (image.complete) {
            if (image.naturalWidth === 0) {
              throw new Error(`Unable to load ${image.src}`);
            }
            return;
          }

          return new Promise((resolve, reject) => {
            image.addEventListener("load", resolve, { once: true });
            image.addEventListener(
              "error",
              () => reject(new Error(`Unable to load ${image.src}`)),
              { once: true },
            );
          });
        }),
      );

      return {
        fontFamily: getComputedStyle(document.body).fontFamily,
        pingFangReady: document.fonts.check(
          '16px "PingFang SC"',
          "浏览器直接批量写入与检查 XMP",
        ),
        images: [...document.images].map((image) => ({
          complete: image.complete,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
        })),
      };
    });

    assert.ok(
      readiness.fontFamily.startsWith('"PingFang SC"') ||
        readiness.fontFamily.startsWith("PingFang SC"),
      `social card must declare PingFang SC first; got ${readiness.fontFamily}`,
    );
    assert.ok(
      readiness.pingFangReady,
      "PingFang SC is unavailable on this macOS capture environment",
    );
    assert.deepEqual(readiness.images, [
      { complete: true, naturalWidth: 1440, naturalHeight: 1560 },
    ]);

    await page.screenshot({
      path: outputPath,
      type: "png",
      fullPage: false,
      animations: "disabled",
    });
    return validateSocialCardFile(outputPath);
  } finally {
    await browser?.close();
  }
}

async function createLock() {
  const files = {};
  for (const relativePath of lockedRelativePaths) {
    files[relativePath] = await sha256File(
      path.join(projectDirectory, relativePath),
    );
  }
  return { contract: CAPTURE_CONTRACT, files };
}

async function writeLock() {
  const temporaryLockPath = temporarySiblingPath(lockPath);
  try {
    const serialized = `${JSON.stringify(await createLock(), null, 2)}\n`;
    JSON.parse(serialized);
    await writeFile(temporaryLockPath, serialized, "utf8");
    await rename(temporaryLockPath, lockPath);
  } finally {
    await rm(temporaryLockPath, { force: true });
  }
}

export async function verifySocialCardLock() {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  assert.deepEqual(
    lock.contract,
    CAPTURE_CONTRACT,
    "social card capture contract has changed; recapture on macOS",
  );
  assert.deepEqual(
    Object.keys(lock.files),
    lockedRelativePaths,
    "social card lock file set is incomplete",
  );

  const packageJson = JSON.parse(
    await readFile(path.join(projectDirectory, "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.devDependencies["@playwright/test"],
    CAPTURE_CONTRACT.playwrightVersion,
    "Playwright version differs from the social card capture contract",
  );

  for (const relativePath of lockedRelativePaths) {
    assert.equal(
      await sha256File(path.join(projectDirectory, relativePath)),
      lock.files[relativePath],
      `${relativePath} differs from social-card.lock.json; recapture on macOS`,
    );
  }
  return lock;
}

export async function captureSocialCard({
  outputPath = committedOutputPath,
  updateLock = outputPath === committedOutputPath,
  platform = process.platform,
  render = renderSocialCard,
  log = console.log,
} = {}) {
  assert.equal(
    platform,
    CAPTURE_CONTRACT.platform,
    "social card capture is supported only on macOS with PingFang SC",
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryOutputPath = temporarySiblingPath(outputPath);

  try {
    await render(temporaryOutputPath);
    await installValidatedPng(temporaryOutputPath, outputPath);
    if (updateLock) {
      await writeLock();
    }
    const result = await validateSocialCardFile(outputPath);
    log(
      `captured ${outputPath} (${result.bytes} bytes, ${CAPTURE_CONTRACT.width}×${CAPTURE_CONTRACT.height})`,
    );
    return result;
  } finally {
    await rm(temporaryOutputPath, { force: true });
  }
}

export async function checkSocialCard({
  platform = process.platform,
  render = renderSocialCard,
  log = console.log,
} = {}) {
  const lock = await verifySocialCardLock();
  if (platform !== CAPTURE_CONTRACT.platform) {
    log("verified social card source lock without platform-specific recapture");
    return "source-lock";
  }

  const temporaryOutputPath = temporarySiblingPath(committedOutputPath);
  try {
    await render(temporaryOutputPath);
    const renderedHash = await sha256File(temporaryOutputPath);
    assert.equal(
      renderedHash,
      lock.files["public/images/social-card.png"],
      "rendered social card differs from the committed PNG; run npm run capture:social",
    );
    log(`verified deterministic social card ${renderedHash}`);
    return renderedHash;
  } finally {
    await rm(temporaryOutputPath, { force: true });
  }
}

export async function runCli(argumentsList) {
  if (argumentsList.length === 0 || argumentsList[0] === "--write") {
    assert.ok(
      argumentsList.length <= 1,
      "Usage: capture-social-card.mjs [--write | --check | --output PATH]",
    );
    return captureSocialCard();
  }

  if (argumentsList[0] === "--check" && argumentsList.length === 1) {
    return checkSocialCard();
  }

  if (argumentsList[0] === "--output" && argumentsList.length === 2) {
    const outputPath = path.resolve(argumentsList[1]);
    assert.notEqual(
      outputPath,
      committedOutputPath,
      "--output cannot target the committed card; use --write instead",
    );
    return captureSocialCard({ outputPath, updateLock: false });
  }

  throw new Error(
    "Usage: capture-social-card.mjs [--write | --check | --output PATH]",
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await runCli(process.argv.slice(2));
}
