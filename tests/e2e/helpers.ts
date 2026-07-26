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
  ensureRange(bytes, offset, 2, "16-bit ZIP field");
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  ensureRange(bytes, offset, 4, "32-bit ZIP field");
  return (
    (bytes[offset] ?? 0) +
    (bytes[offset + 1] ?? 0) * 0x100 +
    (bytes[offset + 2] ?? 0) * 0x10000 +
    (bytes[offset + 3] ?? 0) * 0x1000000
  ) >>> 0;
}

function ensureRange(
  bytes: Uint8Array,
  offset: number,
  length: number,
  label: string,
  end = bytes.length,
): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > end ||
    length > end - offset
  ) {
    throw new Error(`Truncated or out-of-bounds ${label}`);
  }
}

function hasSignature(
  bytes: Uint8Array,
  offset: number,
  signature: number,
): boolean {
  return (
    offset >= 0 &&
    offset + 4 <= bytes.length &&
    readU32(bytes, offset) === signature
  );
}

export interface ParsedZipEntry {
  name: string;
  method: number;
  crc: number;
  data: Uint8Array;
}

export function parseStoredZip(bytes: Uint8Array): ParsedZipEntry[] {
  const minimumEocdLength = 22;
  if (bytes.length < minimumEocdLength) {
    throw new Error("ZIP EOCD not found");
  }
  let eocd = -1;
  const earliestEocd = Math.max(
    0,
    bytes.length - minimumEocdLength - 0xffff,
  );
  for (
    let candidate = bytes.length - minimumEocdLength;
    candidate >= earliestEocd;
    candidate -= 1
  ) {
    if (
      hasSignature(bytes, candidate, 0x06054b50) &&
      candidate +
        minimumEocdLength +
        readU16(bytes, candidate + 20) ===
        bytes.length
    ) {
      eocd = candidate;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP EOCD not found");

  const diskNumber = readU16(bytes, eocd + 4);
  const centralDisk = readU16(bytes, eocd + 6);
  const diskCount = readU16(bytes, eocd + 8);
  const count = readU16(bytes, eocd + 10);
  const centralSize = readU32(bytes, eocd + 12);
  const centralOffset = readU32(bytes, eocd + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || diskCount !== count) {
    throw new Error("Multi-disk ZIP archives are unsupported");
  }
  if (
    count === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error("ZIP64 archives are unsupported");
  }
  ensureRange(
    bytes,
    centralOffset,
    centralSize,
    "ZIP central directory",
    eocd,
  );
  if (centralOffset + centralSize !== eocd) {
    throw new Error("Invalid ZIP central directory extent");
  }

  let central = centralOffset;
  const centralEnd = centralOffset + centralSize;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ParsedZipEntry[] = [];
  const localRanges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < count; index += 1) {
    ensureRange(bytes, central, 46, "ZIP central header", centralEnd);
    if (!hasSignature(bytes, central, 0x02014b50)) {
      throw new Error("Invalid ZIP central directory");
    }
    const flags = readU16(bytes, central + 8);
    const method = readU16(bytes, central + 10);
    const crc = readU32(bytes, central + 16);
    const compressedSize = readU32(bytes, central + 20);
    const uncompressedSize = readU32(bytes, central + 24);
    const filenameLength = readU16(bytes, central + 28);
    const extraLength = readU16(bytes, central + 30);
    const commentLength = readU16(bytes, central + 32);
    const centralStartDisk = readU16(bytes, central + 34);
    const localOffset = readU32(bytes, central + 42);
    const centralRecordLength =
      46 + filenameLength + extraLength + commentLength;
    ensureRange(
      bytes,
      central,
      centralRecordLength,
      "ZIP central record",
      centralEnd,
    );
    if (centralStartDisk !== 0) {
      throw new Error("Multi-disk ZIP archives are unsupported");
    }
    if ((flags & ~0x0808) !== 0) {
      throw new Error("Unsupported ZIP general-purpose flags");
    }
    if (method !== 0) {
      throw new Error("Only stored ZIP entries are supported");
    }
    if (compressedSize !== uncompressedSize) {
      throw new Error("Stored ZIP entry size mismatch");
    }
    if (filenameLength === 0) {
      throw new Error("ZIP entry filename is empty");
    }
    const centralNameBytes = bytes.subarray(
      central + 46,
      central + 46 + filenameLength,
    );
    const name = decoder.decode(centralNameBytes);

    ensureRange(bytes, localOffset, 30, "ZIP local header", centralOffset);
    if (!hasSignature(bytes, localOffset, 0x04034b50)) {
      throw new Error("Invalid ZIP local header");
    }
    const localFlags = readU16(bytes, localOffset + 6);
    const localMethod = readU16(bytes, localOffset + 8);
    const localCrc = readU32(bytes, localOffset + 14);
    const localCompressedSize = readU32(bytes, localOffset + 18);
    const localUncompressedSize = readU32(bytes, localOffset + 22);
    const localNameLength = readU16(bytes, localOffset + 26);
    const localExtraLength = readU16(bytes, localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    ensureRange(
      bytes,
      localOffset,
      30 + localNameLength + localExtraLength,
      "ZIP local record",
      centralOffset,
    );
    const localNameBytes = bytes.subarray(
      localOffset + 30,
      localOffset + 30 + localNameLength,
    );
    if (
      localNameLength !== filenameLength ||
      decoder.decode(localNameBytes) !== name
    ) {
      throw new Error(`ZIP local/central filename mismatch for ${name}`);
    }
    if (localFlags !== flags || localMethod !== method) {
      throw new Error(`ZIP local/central flags or method mismatch for ${name}`);
    }
    const hasDataDescriptor = (flags & 0x0008) !== 0;
    if (
      (!hasDataDescriptor &&
        (localCrc !== crc ||
          localCompressedSize !== compressedSize ||
          localUncompressedSize !== uncompressedSize)) ||
      (hasDataDescriptor &&
        ((localCrc !== 0 && localCrc !== crc) ||
          (localCompressedSize !== 0 &&
            localCompressedSize !== compressedSize) ||
          (localUncompressedSize !== 0 &&
            localUncompressedSize !== uncompressedSize)))
    ) {
      throw new Error(`ZIP local/central size or CRC mismatch for ${name}`);
    }
    ensureRange(
      bytes,
      dataOffset,
      compressedSize,
      "ZIP entry data",
      centralOffset,
    );
    const dataEnd = dataOffset + compressedSize;
    const data = bytes.slice(dataOffset, dataOffset + compressedSize);
    let localEnd = dataEnd;
    if (hasDataDescriptor) {
      ensureRange(bytes, dataEnd, 16, "ZIP data descriptor", centralOffset);
      if (
        !hasSignature(bytes, dataEnd, 0x08074b50) ||
        readU32(bytes, dataEnd + 4) !== crc ||
        readU32(bytes, dataEnd + 8) !== compressedSize ||
        readU32(bytes, dataEnd + 12) !== uncompressedSize
      ) {
        throw new Error(`Invalid ZIP data descriptor for ${name}`);
      }
      localEnd += 16;
    }
    if (crc32(data) !== crc) {
      throw new Error(`ZIP CRC mismatch for ${name}`);
    }
    entries.push({ name, method, crc, data });
    localRanges.push({ start: localOffset, end: localEnd });
    central += centralRecordLength;
  }
  if (central !== centralEnd) {
    throw new Error("Invalid ZIP central directory extent or entry count");
  }
  localRanges.sort((left, right) => left.start - right.start);
  let localCursor = 0;
  for (const range of localRanges) {
    if (range.start !== localCursor || range.end < range.start) {
      throw new Error("Invalid or overlapping ZIP local record layout");
    }
    localCursor = range.end;
  }
  if (localCursor !== centralOffset) {
    throw new Error("Invalid ZIP local record extent");
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
