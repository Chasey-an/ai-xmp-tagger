import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { chromium } from "@playwright/test";

const execFileAsync = promisify(execFile);
const TARGET = "contains-synthetic-performer";
const PROCESS_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 90_000;

test(
  "ExifTool independently reads exactly one XMP-dc Subject in browser outputs",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const version = spawnSync("exiftool", ["-ver"], {
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    if (version.error?.code === "ENOENT") {
      if (process.env.CI) {
        assert.fail("ExifTool is required in CI but was not found on PATH");
      }
      t.skip(
        "ExifTool not installed; local interop verification skipped explicitly",
      );
      return;
    }
    assert.equal(
      version.status,
      0,
      `\`exiftool -ver\` failed or timed out: ${
        version.error?.message ?? version.stderr
      }`,
    );

    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "ai-xmp-exiftool-"),
    );
    let server;
    let browser;
    t.after(async () => {
      try {
        await browser?.close();
      } finally {
        try {
          await server?.close();
        } finally {
          await rm(temporaryDirectory, { recursive: true, force: true });
        }
      }
    });

    const { startCspServer } = await import("../e2e/serve-dist-csp.mjs");
    server = await startCspServer({ port: 0 });
    browser = await chromium.launch();
    const fixtureNames = [
      "neutral-1x1.jpg",
      "neutral-1x1.png",
      "neutral-1x1.webp",
    ];
    const outputs = [];
    for (const fixtureName of fixtureNames) {
      const page = await browser.newPage();
      page.setDefaultTimeout(PROCESS_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(PROCESS_TIMEOUT_MS);
      await page.goto(server.url, { waitUntil: "load" });
      await page
        .getByRole("radio", { name: "保持原格式并写入标签" })
        .check();
      const source = await decodeFixture(fixtureName);
      const sourcePath = path.join(temporaryDirectory, fixtureName);
      await writeFile(sourcePath, source);
      await page.getByLabel("选择图片文件", { exact: true }).setInputFiles(sourcePath);
      await page.getByRole("button", { name: "开始处理" }).click();
      await page.getByRole("heading", { name: "处理结果" }).waitFor();
      const downloadEvent = page.waitForEvent("download", {
        timeout: PROCESS_TIMEOUT_MS,
      });
      await page.getByRole("button", { name: "下载处理后的图片" }).click();
      const download = await downloadEvent;
      const outputPath = path.join(
        temporaryDirectory,
        path.basename(download.suggestedFilename()),
      );
      await download.saveAs(outputPath);
      outputs.push({ fixtureName, source, outputPath });
      await page.close();
    }

    for (const { outputPath } of outputs) {
      const { stdout } = await execFileAsync(
        "exiftool",
        ["-json", "-G1", "-XMP-dc:Subject", outputPath],
        {
          encoding: "utf8",
          timeout: PROCESS_TIMEOUT_MS,
          killSignal: "SIGKILL",
          maxBuffer: 1024 * 1024,
        },
      );
      const records = JSON.parse(stdout);
      assert.equal(records.length, 1);
      assert.equal(countExactValues(records[0]["XMP-dc:Subject"]), 1);
    }
    const jpeg = outputs.find(({ fixtureName }) => fixtureName.endsWith(".jpg"));
    assert.ok(jpeg);
    assert.deepEqual(
      extractJpegScan(await readFile(jpeg.outputPath)),
      extractJpegScan(jpeg.source),
    );
  },
);

async function decodeFixture(name) {
  const value = await readFile(
    path.resolve("tests/fixtures", `${name}.b64`),
    "utf8",
  );
  return Buffer.from(value.trim(), "base64");
}

function countExactValues(value) {
  if (Array.isArray(value)) {
    return value.reduce((count, entry) => count + countExactValues(entry), 0);
  }
  return value === TARGET ? 1 : 0;
}

function extractJpegScan(bytes) {
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);
  let offset = 2;
  while (offset < bytes.length) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    assert.notEqual(marker, undefined);
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    const length = bytes.readUInt16BE(offset);
    assert.ok(length >= 2 && offset + length <= bytes.length);
    if (marker === 0xda) {
      const start = offset + length;
      let end = bytes.length - 2;
      while (end >= start && !(bytes[end] === 0xff && bytes[end + 1] === 0xd9)) {
        end -= 1;
      }
      assert.ok(end >= start);
      return bytes.subarray(start, end);
    }
    offset += length;
  }
  assert.fail("JPEG has no SOS");
}
