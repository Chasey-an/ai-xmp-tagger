import { expect, test } from "@playwright/test";

import {
  assertMagic,
  captureDownload,
  chooseMode,
  countExactTarget,
  parseStoredZip,
  processUploaded,
  upload,
} from "./helpers";

test("two successes plus one corrupt failure download a safe partial-success ZIP and matching CSV", async ({
  page,
}) => {
  await page.goto("/");
  await upload(page, [
    { fixture: "neutral-1x1.png", name: "dup.png" },
    { fixture: "neutral-1x1.png", name: "DUP.png" },
    { fixture: "intake-only-corrupt.jpg", name: "=2+2.jpg" },
  ]);
  await processUploaded(page);
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await expect(page.locator("tbody tr").filter({ hasText: "=2+2.jpg" })).toContainText(
    "× 失败",
  );

  const output = await captureDownload(
    page,
    /下载 2 个成功文件（ZIP）/u,
  );
  expect(output.filename).toMatch(/^AI_XMP_Output_\d{8}-\d{4}\.zip$/u);
  const entries = parseStoredZip(output.bytes);
  expect(entries).toHaveLength(3);
  expect(new Set(entries.map(({ name }) => name)).size).toBe(entries.length);
  for (const { name } of entries) {
    expect(name).toMatch(/^AI_XMP_Output\/[^\\]+$/u);
    expect(name).not.toMatch(/(?:^|\/)\.\.(?:\/|$)|^[A-Za-z]:|^\/|\\/u);
  }

  const imageEntries = entries.filter(({ name }) => !name.endsWith(".csv"));
  expect(imageEntries.map(({ name }) => name).sort()).toEqual([
    "AI_XMP_Output/DUP_xmp-2.jpg",
    "AI_XMP_Output/dup_xmp.jpg",
  ]);
  for (const entry of imageEntries) {
    expect(entry.method).toBe(0);
    assertMagic(entry.name, entry.data);
    expect(countExactTarget(entry.data)).toBe(1);
  }

  const report = entries.find(({ name }) =>
    name.endsWith("/processing-report.csv"),
  );
  expect(report).toBeDefined();
  expect(report!.method).toBe(0);
  const csv = Buffer.from(report!.data).toString("utf8");
  expect(csv.startsWith("\uFEFF")).toBe(true);
  expect(csv).toContain("\r\n");
  expect(csv.replaceAll("\r\n", "")).not.toContain("\n");
  expect(csv).toContain("dup_xmp.jpg");
  expect(csv).toContain("DUP_xmp-2.jpg");
  expect(csv).toContain("'=2+2.jpg");
  expect(csv).not.toMatch(/\/Users\/|[A-Za-z]:\\|\\\\[^\\]+\\/u);

  const localNameMismatch = Buffer.from(output.bytes);
  const localHeader = localNameMismatch.indexOf(
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  );
  expect(localHeader).toBeGreaterThanOrEqual(0);
  Buffer.from("../", "utf8").copy(localNameMismatch, localHeader + 30);
  expect(() => parseStoredZip(localNameMismatch)).toThrow(/filename mismatch/iu);

  const multiDisk = Buffer.from(output.bytes);
  const eocd = multiDisk.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThanOrEqual(0);
  multiDisk.writeUInt16LE(1, eocd + 4);
  expect(() => parseStoredZip(multiDisk)).toThrow(/multi-disk/iu);

  const inconsistentCentralSize = Buffer.from(output.bytes);
  const centralSize = inconsistentCentralSize.readUInt32LE(eocd + 12);
  inconsistentCentralSize.writeUInt32LE(centralSize - 1, eocd + 12);
  expect(() => parseStoredZip(inconsistentCentralSize)).toThrow(
    /central directory extent/iu,
  );

  const unsupportedFlags = Buffer.from(output.bytes);
  const centralOffset = unsupportedFlags.readUInt32LE(eocd + 16);
  unsupportedFlags.writeUInt16LE(
    unsupportedFlags.readUInt16LE(centralOffset + 8) | 0x0001,
    centralOffset + 8,
  );
  expect(() => parseStoredZip(unsupportedFlags)).toThrow(/unsupported.*flags/iu);

  const inconsistentLocalSize = Buffer.from(output.bytes);
  inconsistentLocalSize.writeUInt32LE(1, localHeader + 18);
  expect(() => parseStoredZip(inconsistentLocalSize)).toThrow(
    /local\/central size or CRC mismatch/iu,
  );

  const truncatedLocalHeader = Buffer.from(output.bytes);
  truncatedLocalHeader.writeUInt32LE(centralOffset - 10, centralOffset + 42);
  expect(() => parseStoredZip(truncatedLocalHeader)).toThrow(
    /local header/iu,
  );

  expect(() => parseStoredZip(output.bytes.subarray(0, output.bytes.length - 5)))
    .toThrow(/EOCD/iu);
});

test("single success downloads a direct image and a separate CSV", async ({
  page,
}) => {
  await page.goto("/");
  await upload(page, ["neutral-1x1.jpg"]);
  await processUploaded(page);

  const image = await captureDownload(page, "下载处理后的图片");
  expect(image.filename).toBe("neutral-1x1_xmp.jpg");
  assertMagic(image.filename, image.bytes);
  expect(countExactTarget(image.bytes)).toBe(1);

  const report = await captureDownload(page, "下载 CSV 报告");
  expect(report.filename).toBe("processing-report.csv");
  const csv = report.bytes.toString("utf8");
  expect(csv.startsWith("\uFEFF")).toBe(true);
  expect(csv).toContain("neutral-1x1_xmp.jpg");
});

test("verify-only offers only a CSV and never an image or ZIP", async ({
  page,
}) => {
  await page.goto("/");
  await chooseMode(page, "只检查 XMP 标签");
  await upload(page, ["neutral-1x1.jpg"]);
  await processUploaded(page);
  await expect(page.getByRole("button", { name: "下载 CSV 报告" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /下载处理后的图片|下载 \d+ 个成功文件/u }),
  ).toHaveCount(0);
  const report = await captureDownload(page, "下载 CSV 报告");
  expect(report.filename).toBe("processing-report.csv");
  expect(report.bytes.toString("utf8")).toContain("已检查");
});
