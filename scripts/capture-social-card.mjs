import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const sourceUrl = new URL("../social-card.html", import.meta.url);
const outputUrl = new URL(
  "../public/images/social-card.png",
  import.meta.url,
);
const outputPath = fileURLToPath(outputUrl);

let browser;

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  await page.goto(sourceUrl.href, { waitUntil: "load" });
  await page.evaluate(async () => {
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
  });

  await page.screenshot({
    path: outputPath,
    type: "png",
    fullPage: false,
    animations: "disabled",
  });

  const [png, outputStat] = await Promise.all([
    readFile(outputUrl),
    stat(outputUrl),
  ]);
  assert.ok(outputStat.size > 20_000, "social card PNG is unexpectedly small");
  assert.equal(
    png.subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
    "social card output must be a PNG",
  );
  assert.equal(png.readUInt32BE(16), 1200, "social card width must be 1200");
  assert.equal(png.readUInt32BE(20), 630, "social card height must be 630");

  console.log(`captured ${outputPath} (${outputStat.size} bytes, 1200×630)`);
} finally {
  await browser?.close();
}
