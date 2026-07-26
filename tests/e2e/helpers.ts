import { expect, type Download, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const TARGET = "contains-synthetic-performer";
export const FIXTURE_ROOT = path.resolve("tests/fixtures");

export type FixtureName =
  | "neutral-1x1.jpg"
  | "neutral-1x1.png"
  | "neutral-1x1.webp"
  | "neutral-1x1.bmp"
  | "intake-only-corrupt.jpg";

export async function fixtureBytes(name: FixtureName): Promise<Buffer> {
  const base64 = await readFile(
    path.join(FIXTURE_ROOT, `${name}.b64`),
    "utf8",
  );
  return Buffer.from(base64.trim(), "base64");
}

export async function upload(
  page: Page,
  fixtures: ReadonlyArray<
    FixtureName | { fixture: FixtureName; name: string }
  >,
): Promise<void> {
  const files = await Promise.all(
    fixtures.map(async (entry) => {
      const fixture = typeof entry === "string" ? entry : entry.fixture;
      const name = typeof entry === "string" ? entry : entry.name;
      return {
        name,
        mimeType: mimeFor(name),
        buffer: await fixtureBytes(fixture),
      };
    }),
  );
  await page.getByLabel("选择图片文件", { exact: true }).setInputFiles(files);
  await expect(page.getByRole("button", { name: "开始处理" })).toBeEnabled();
}

function mimeFor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/bmp";
}

export async function processUploaded(page: Page): Promise<void> {
  await page.getByRole("button", { name: "开始处理" }).click();
  await expect(page.getByRole("heading", { name: "处理结果" })).toBeVisible({
    timeout: 30_000,
  });
}

export async function chooseMode(
  page: Page,
  name:
    | "转为高清 JPG 并写入标签"
    | "保持原格式并写入标签"
    | "只检查 XMP 标签",
): Promise<void> {
  await page.getByRole("radio", { name, exact: true }).check();
}

export async function captureDownload(
  page: Page,
  buttonName: string | RegExp,
): Promise<{ download: Download; bytes: Buffer; filename: string }> {
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: buttonName }).click();
  const download = await event;
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "ai-xmp-e2e-download-"),
  );
  try {
    const filename = download.suggestedFilename();
    const destination = path.join(temporaryDirectory, path.basename(filename));
    await download.saveAs(destination);
    return {
      download,
      filename,
      bytes: await readFile(destination),
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function countExactTarget(bytes: Uint8Array): number {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const escaped = TARGET.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [...text.matchAll(new RegExp(`(?:^|[>\\s])${escaped}(?=[<\\s]|$)`, "gu"))]
    .length;
}

export function assertMagic(filename: string, bytes: Uint8Array): void {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    return;
  }
  if (lower.endsWith(".png")) {
    expect([...bytes.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    return;
  }
  if (lower.endsWith(".webp")) {
    expect(Buffer.from(bytes.subarray(0, 4)).toString("ascii")).toBe("RIFF");
    expect(Buffer.from(bytes.subarray(8, 12)).toString("ascii")).toBe("WEBP");
    return;
  }
  throw new Error(`Unexpected output extension: ${filename}`);
}

export function extractJpegScan(bytes: Uint8Array): Uint8Array {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("Not a JPEG");
  }
  let offset = 2;
  while (offset < bytes.length) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined) throw new Error("Truncated JPEG marker");
    if (marker === 0xd9) throw new Error("JPEG has no scan");
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    const length = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
    if (length < 2 || offset + length > bytes.length) {
      throw new Error("Invalid JPEG segment length");
    }
    if (marker === 0xda) {
      const start = offset + length;
      let end = bytes.length - 2;
      while (
        end >= start &&
        !(bytes[end] === 0xff && bytes[end + 1] === 0xd9)
      ) {
        end -= 1;
      }
      if (end < start) throw new Error("Missing JPEG EOI");
      return bytes.slice(start, end);
    }
    offset += length;
  }
  throw new Error("JPEG has no scan");
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) +
    (bytes[offset + 1] ?? 0) * 0x100 +
    (bytes[offset + 2] ?? 0) * 0x10000 +
    (bytes[offset + 3] ?? 0) * 0x1000000
  ) >>> 0;
}

export interface ParsedZipEntry {
  name: string;
  method: number;
  crc: number;
  data: Uint8Array;
}

export function parseStoredZip(bytes: Uint8Array): ParsedZipEntry[] {
  let eocd = bytes.length - 22;
  while (
    eocd >= 0 &&
    !(
      bytes[eocd] === 0x50 &&
      bytes[eocd + 1] === 0x4b &&
      bytes[eocd + 2] === 0x05 &&
      bytes[eocd + 3] === 0x06
    )
  ) {
    eocd -= 1;
  }
  if (eocd < 0) throw new Error("ZIP EOCD not found");
  const count = readU16(bytes, eocd + 10);
  let central = readU32(bytes, eocd + 16);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ParsedZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (readU32(bytes, central) !== 0x02014b50) {
      throw new Error("Invalid ZIP central directory");
    }
    const method = readU16(bytes, central + 10);
    const crc = readU32(bytes, central + 16);
    const compressedSize = readU32(bytes, central + 20);
    const filenameLength = readU16(bytes, central + 28);
    const extraLength = readU16(bytes, central + 30);
    const commentLength = readU16(bytes, central + 32);
    const localOffset = readU32(bytes, central + 42);
    const name = decoder.decode(
      bytes.subarray(central + 46, central + 46 + filenameLength),
    );
    if (readU32(bytes, localOffset) !== 0x04034b50) {
      throw new Error("Invalid ZIP local header");
    }
    const localNameLength = readU16(bytes, localOffset + 26);
    const localExtraLength = readU16(bytes, localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.slice(dataOffset, dataOffset + compressedSize);
    if (method === 0 && crc32(data) !== crc) {
      throw new Error(`ZIP CRC mismatch for ${name}`);
    }
    entries.push({ name, method, crc, data });
    central += 46 + filenameLength + extraLength + commentLength;
  }
  return entries;
}

export async function writeFixtureTo(
  directory: string,
  fixture: FixtureName,
  outputName = fixture,
): Promise<string> {
  const destination = path.join(directory, path.basename(outputName));
  await writeFile(destination, await fixtureBytes(fixture));
  return destination;
}
