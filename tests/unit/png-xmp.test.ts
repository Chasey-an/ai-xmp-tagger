// @vitest-environment node

import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { MAX_XMP_BYTES } from "../../src/core/constants";
import { ProcessingError } from "../../src/core/errors";
import {
  MAX_PNG_CHUNKS,
  crc32,
  listPngChunks,
  readPngXmp,
  writePngXmp,
} from "../../src/core/xmp/png";
import {
  concatBytes,
  knownValidPng1x1,
  minimalPng,
  pngChunk,
  utf8Bytes,
} from "../helpers/binary-fixtures";

const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const XMP_KEYWORD = utf8Bytes("XML:com.adobe.xmp");

function xmpPayload(
  packet: string | Uint8Array,
  structuralFields: Uint8Array | readonly number[] = [0, 0, 0, 0],
): Uint8Array {
  return concatBytes(
    XMP_KEYWORD,
    [0],
    structuralFields,
    typeof packet === "string" ? utf8Bytes(packet) : packet,
  );
}

function xmpChunk(
  packet: string | Uint8Array,
  structuralFields?: Uint8Array | readonly number[],
): Uint8Array {
  return pngChunk("iTXt", xmpPayload(packet, structuralFields));
}

function normalInternationalText(keyword: string, text: string): Uint8Array {
  return pngChunk(
    "iTXt",
    concatBytes(utf8Bytes(keyword), [0, 0, 0, 0, 0], utf8Bytes(text)),
  );
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  ) >>> 0;
}

function expectProcessingError(
  operation: () => unknown,
  code:
    | "CORRUPT_CONTAINER"
    | "INVALID_XMP"
    | "LIMIT_EXCEEDED"
    | "XMP_CONFLICT",
): void {
  try {
    operation();
    throw new Error("Expected operation to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ProcessingError);
    expect(error).toMatchObject({ name: "ProcessingError", code });
  }
}

function expectContainerRejected(input: Uint8Array): void {
  expectProcessingError(() => listPngChunks(input), "CORRUPT_CONTAINER");
  expectProcessingError(() => readPngXmp(input), "CORRUPT_CONTAINER");
  expectProcessingError(
    () => writePngXmp(input, "<replacement/>"),
    "CORRUPT_CONTAINER",
  );
}

function independentChunkCrcIsValid(raw: Uint8Array): boolean {
  const dataLength = readUint32(raw, 0);
  const crcOffset = 8 + dataLength;
  return crc32(raw.subarray(4, crcOffset)) === readUint32(raw, crcOffset);
}

function corruptChunkCrc(
  bytes: Uint8Array,
  targetType: string,
): Uint8Array {
  const chunks = listPngChunks(bytes);
  let chunkOffset = PNG_SIGNATURE.length;

  for (const chunk of chunks) {
    if (chunk.type === targetType) {
      const corrupted = bytes.slice();
      const lastCrcByteOffset = chunkOffset + chunk.raw.length - 1;
      corrupted[lastCrcByteOffset] =
        corrupted[lastCrcByteOffset]! ^ 0x01;
      return corrupted;
    }
    chunkOffset += chunk.raw.length;
  }

  throw new Error(`Fixture does not contain a ${targetType} chunk`);
}

function pngWithChunkCount(chunkCount: number): Uint8Array {
  if (chunkCount < 3) {
    throw new RangeError("Fixture needs IHDR, XMP iTXt, and IEND");
  }

  const compactChunk = pngChunk("vpAg");
  return minimalPng([
    ...Array.from({ length: chunkCount - 3 }, () => compactChunk),
    xmpChunk("<limit/>"),
  ]);
}

function pngWithoutXmpAtChunkCount(chunkCount: number): Uint8Array {
  if (chunkCount < 2) {
    throw new RangeError("Fixture needs IHDR and IEND");
  }

  const compactChunk = pngChunk("vpAg");
  return minimalPng(
    Array.from({ length: chunkCount - 2 }, () => compactChunk),
  );
}

describe("PNG XMP iTXt", () => {
  it("writes XMP into a hardcoded real 1x1 PNG and preserves IDAT raw bytes", () => {
    const input = knownValidPng1x1();
    const inputChunks = listPngChunks(input);
    const packet = "<x:xmpmeta>real-png</x:xmpmeta>";

    const output = writePngXmp(input, packet);
    const outputNonXmp = listPngChunks(output).filter(
      ({ type }) => type !== "iTXt",
    );

    expect(inputChunks.map(({ type }) => type)).toEqual([
      "IHDR",
      "IDAT",
      "IEND",
    ]);
    const decodedScanline = inflateSync(
      concatBytes(
        ...inputChunks
          .filter(({ type }) => type === "IDAT")
          .map(({ data }) => data),
      ),
    );
    expect(Array.from(decodedScanline)).toEqual([1, 0, 255]);
    expect(readPngXmp(output)).toBe(packet);
    expect(outputNonXmp.map(({ raw }) => raw)).toEqual(
      inputChunks.map(({ raw }) => raw),
    );
  });

  it("inserts XMP immediately before IEND beside another iTXt chunk", () => {
    const otherText = normalInternationalText("Description", "kept");
    const input = minimalPng([otherText]);
    const packet = "<x:xmpmeta>target</x:xmpmeta>";

    const output = writePngXmp(input, packet);
    const chunks = listPngChunks(output);

    expect(readPngXmp(output)).toBe(packet);
    expect(chunks.map(({ type }) => type)).toEqual([
      "IHDR",
      "iTXt",
      "iTXt",
      "IEND",
    ]);
    expect(chunks.filter(({ type }) => type === "iTXt")).toHaveLength(2);
    expect(chunks.at(-2)?.data).toEqual(xmpPayload(packet));
    expect(chunks.every(({ raw }) => independentChunkCrcIsValid(raw))).toBe(
      true,
    );
  });

  it("replaces one existing XMP chunk in its exact location", () => {
    const before = pngChunk("vpAg", [1, 2, 3]);
    const after = pngChunk("tEXt", concatBytes(utf8Bytes("Note"), [0, 4, 5]));
    const input = minimalPng([before, xmpChunk("<old/>"), after]);

    const output = writePngXmp(input, "<new/>");
    const chunks = listPngChunks(output);

    expect(readPngXmp(output)).toBe("<new/>");
    expect(chunks.map(({ type }) => type)).toEqual([
      "IHDR",
      "vpAg",
      "iTXt",
      "tEXt",
      "IEND",
    ]);
    expect(
      chunks.filter(
        ({ type, data }) =>
          type === "iTXt" &&
          data.subarray(0, XMP_KEYWORD.length).every(
            (byte, index) => byte === XMP_KEYWORD[index],
          ),
      ),
    ).toHaveLength(1);
  });

  it("preserves every non-XMP chunk raw byte-for-byte and in order", () => {
    const unknown = pngChunk("vpAg", [0xff, 0x00, 0xaa, 0x55]);
    const normalText = pngChunk(
      "tEXt",
      concatBytes(utf8Bytes("Comment"), [0], utf8Bytes("unchanged")),
    );
    const normalIText = normalInternationalText("Title", "原样");
    const input = minimalPng([
      unknown,
      normalText,
      xmpChunk("<old/>"),
      normalIText,
    ]);
    const originalNonXmp = listPngChunks(input)
      .filter(
        ({ type, data }) =>
          type !== "iTXt" ||
          !data.subarray(0, XMP_KEYWORD.length).every(
            (byte, index) => byte === XMP_KEYWORD[index],
          ),
      )
      .map(({ raw }) => raw);

    const output = writePngXmp(input, "<replacement/>");
    const outputNonXmp = listPngChunks(output)
      .filter(
        ({ type, data }) =>
          type !== "iTXt" ||
          !data.subarray(0, XMP_KEYWORD.length).every(
            (byte, index) => byte === XMP_KEYWORD[index],
          ),
      )
      .map(({ raw }) => raw);

    expect(outputNonXmp).toEqual(originalNonXmp);
  });

  it("lists exact full raw chunks and their payloads", () => {
    const ancillary = pngChunk("vpAg", [7, 8, 9]);
    const chunks = listPngChunks(minimalPng([ancillary]));

    expect(chunks[1]).toMatchObject({ type: "vpAg" });
    expect(chunks[1]?.raw).toEqual(ancillary);
    expect(chunks[1]?.data).toEqual(new Uint8Array([7, 8, 9]));
  });

  it("returns null when no exact XMP keyword is present", () => {
    const lookalike = pngChunk(
      "iTXt",
      concatBytes(utf8Bytes("XML:com.adobe.xmp.extra"), [
        0, 0, 0, 0, 0,
      ], utf8Bytes("<not-xmp/>")),
    );

    expect(readPngXmp(minimalPng([lookalike]))).toBeNull();
  });

  it("rejects duplicate XMP chunks with XMP_CONFLICT", () => {
    const input = minimalPng([xmpChunk("<first/>"), xmpChunk("<second/>")]);

    expectProcessingError(() => readPngXmp(input), "XMP_CONFLICT");
    expectProcessingError(
      () => writePngXmp(input, "<replacement/>"),
      "XMP_CONFLICT",
    );
  });

  it.each(["IHDR", "iTXt", "IDAT", "IEND"])(
    "rejects a bad CRC in the %s chunk without changing its payload",
    (targetType) => {
      const input = minimalPng([
        xmpChunk("<packet/>"),
        pngChunk("IDAT", [0x78, 0x9c, 0x01, 0x02, 0x03]),
      ]);
      const corrupted = corruptChunkCrc(input, targetType);
      const changedOffsets = Array.from(input.keys()).filter(
        (offset) => input[offset] !== corrupted[offset],
      );
      const chunks = listPngChunks(input);
      const targetIndex = chunks.findIndex(({ type }) => type === targetType);
      const targetOffset =
        PNG_SIGNATURE.length +
        chunks
          .slice(0, targetIndex)
          .reduce((total, chunk) => total + chunk.raw.length, 0);
      const target = chunks[targetIndex]!;

      expect(changedOffsets).toEqual([
        targetOffset + target.raw.length - 1,
      ]);
      expectContainerRejected(corrupted);
    },
  );

  it.each([
    ["bad signature", concatBytes([0x89, 0x50, 0x4e, 0x47])],
    [
      "truncated chunk length",
      concatBytes(PNG_SIGNATURE, [0x00, 0x00, 0x00]),
    ],
    [
      "truncated chunk type",
      concatBytes(PNG_SIGNATURE, [0x00, 0x00, 0x00, 0x00, 0x49, 0x48]),
    ],
    [
      "truncated chunk data",
      concatBytes(
        PNG_SIGNATURE,
        [0x00, 0x00, 0x00, 0x0d],
        utf8Bytes("IHDR"),
        [0, 0, 0],
      ),
    ],
    [
      "truncated chunk CRC",
      minimalPng().subarray(0, minimalPng().length - 1),
    ],
    [
      "declared uint32 length exceeds remaining bytes",
      concatBytes(
        PNG_SIGNATURE,
        [0xff, 0xff, 0xff, 0xf0],
        utf8Bytes("IHDR"),
        [0, 0, 0, 1],
      ),
    ],
  ])("rejects %s without arithmetic wrap", (_label, input) => {
    expectContainerRejected(input);
  });

  it.each([
    ["missing IHDR", concatBytes(PNG_SIGNATURE, pngChunk("IEND"))],
    [
      "IHDR not first",
      concatBytes(
        PNG_SIGNATURE,
        pngChunk("tEXt", [1]),
        pngChunk("IHDR", new Uint8Array(13)),
        pngChunk("IEND"),
      ),
    ],
    [
      "duplicate IHDR",
      concatBytes(
        PNG_SIGNATURE,
        pngChunk("IHDR", new Uint8Array(13)),
        pngChunk("IHDR", new Uint8Array(13)),
        pngChunk("IEND"),
      ),
    ],
    [
      "wrong IHDR length",
      concatBytes(
        PNG_SIGNATURE,
        pngChunk("IHDR", new Uint8Array(12)),
        pngChunk("IEND"),
      ),
    ],
    [
      "missing IEND",
      concatBytes(PNG_SIGNATURE, pngChunk("IHDR", new Uint8Array(13))),
    ],
    [
      "duplicate IEND",
      concatBytes(minimalPng(), pngChunk("IEND")),
    ],
    [
      "IEND not last",
      concatBytes(minimalPng(), pngChunk("tEXt", [1])),
    ],
    [
      "wrong IEND length",
      concatBytes(
        PNG_SIGNATURE,
        pngChunk("IHDR", new Uint8Array(13)),
        pngChunk("IEND", [0]),
      ),
    ],
    ["trailing bytes", concatBytes(minimalPng(), [0xde, 0xad])],
  ])("rejects %s as CORRUPT_CONTAINER", (_label, input) => {
    expectContainerRejected(input);
  });

  it("accepts exactly MAX_PNG_CHUNKS for list, read, and replacement", () => {
    expect(MAX_PNG_CHUNKS).toBe(16_384);
    const input = pngWithChunkCount(MAX_PNG_CHUNKS);

    expect(listPngChunks(input)).toHaveLength(MAX_PNG_CHUNKS);
    expect(readPngXmp(input)).toBe("<limit/>");

    const output = writePngXmp(input, "<replacement/>");
    expect(listPngChunks(output)).toHaveLength(MAX_PNG_CHUNKS);
    expect(readPngXmp(output)).toBe("<replacement/>");
  });

  it("rejects MAX_PNG_CHUNKS + 1 in list, read, and write", () => {
    const input = pngWithChunkCount(MAX_PNG_CHUNKS + 1);

    expectProcessingError(() => listPngChunks(input), "LIMIT_EXCEEDED");
    expectProcessingError(() => readPngXmp(input), "LIMIT_EXCEEDED");
    expectProcessingError(
      () => writePngXmp(input, "<replacement/>"),
      "LIMIT_EXCEEDED",
    );
  });

  it("rejects insertion when it would exceed MAX_PNG_CHUNKS", () => {
    const input = pngWithoutXmpAtChunkCount(MAX_PNG_CHUNKS);

    expect(listPngChunks(input)).toHaveLength(MAX_PNG_CHUNKS);
    expect(readPngXmp(input)).toBeNull();
    expectProcessingError(
      () => writePngXmp(input, "<inserted/>"),
      "LIMIT_EXCEEDED",
    );
  });

  it.each([
    ["compression flag 1", [1, 0, 0, 0]],
    ["compression method 1", [0, 1, 0, 0]],
    ["non-empty language tag", [0, 0, 0x65, 0x6e, 0]],
    ["non-empty translated keyword", [0, 0, 0, 0x58, 0]],
    ["missing structural fields", []],
    ["truncated translated-keyword field", [0, 0, 0]],
  ])("rejects XMP with %s as INVALID_XMP", (_label, fields) => {
    const input = minimalPng([xmpChunk("<packet/>", fields)]);

    expectProcessingError(() => readPngXmp(input), "INVALID_XMP");
    expectProcessingError(
      () => writePngXmp(input, "<replacement/>"),
      "INVALID_XMP",
    );
  });

  it("rejects malformed UTF-8 in an XMP packet as INVALID_XMP", () => {
    const input = minimalPng([xmpChunk(new Uint8Array([0xc3, 0x28]))]);

    expectProcessingError(() => readPngXmp(input), "INVALID_XMP");
    expectProcessingError(
      () => writePngXmp(input, "<replacement/>"),
      "INVALID_XMP",
    );
  });

  it("rejects a lone surrogate packet on write as INVALID_XMP", () => {
    expectProcessingError(
      () => writePngXmp(minimalPng(), "\ud800"),
      "INVALID_XMP",
    );
  });

  it("accepts exactly MAX_XMP_BYTES including a multibyte boundary", () => {
    const packet = `${"a".repeat(MAX_XMP_BYTES - 3)}中`;
    expect(utf8Bytes(packet)).toHaveLength(MAX_XMP_BYTES);

    const existing = minimalPng([xmpChunk(packet)]);
    expect(readPngXmp(existing)).toBe(packet);

    const output = writePngXmp(minimalPng(), packet);
    expect(readPngXmp(output)).toBe(packet);
  });

  it("rejects MAX_XMP_BYTES + 1 on existing and replacement packets", () => {
    const packet = `${"a".repeat(MAX_XMP_BYTES - 2)}中`;
    expect(utf8Bytes(packet)).toHaveLength(MAX_XMP_BYTES + 1);
    const existing = minimalPng([xmpChunk(packet)]);

    expectProcessingError(() => readPngXmp(existing), "INVALID_XMP");
    expectProcessingError(
      () => writePngXmp(existing, "<replacement/>"),
      "INVALID_XMP",
    );
    expectProcessingError(
      () => writePngXmp(minimalPng(), packet),
      "INVALID_XMP",
    );
  });

  it("rejects oversized existing XMP before attempting UTF-8 decode", () => {
    const oversizedInvalidUtf8 = new Uint8Array(MAX_XMP_BYTES + 1);
    oversizedInvalidUtf8.fill(0x61);
    oversizedInvalidUtf8[MAX_XMP_BYTES] = 0xff;
    const input = minimalPng([xmpChunk(oversizedInvalidUtf8)]);

    try {
      readPngXmp(input);
      throw new Error("Expected operation to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProcessingError);
      expect(error).toMatchObject({ code: "INVALID_XMP" });
      expect("cause" in (error as object)).toBe(false);
    }
  });

  it("round-trips Unicode, Chinese, and a leading UTF-8 BOM", () => {
    const packet =
      '\uFEFF<x:xmpmeta><rdf:Description>中文 café — 🎨</rdf:Description></x:xmpmeta>';

    const inserted = writePngXmp(minimalPng(), packet);
    const replaced = writePngXmp(inserted, readPngXmp(inserted) ?? "");

    expect(readPngXmp(inserted)).toBe(packet);
    expect(readPngXmp(replaced)).toBe(packet);
  });

  it("computes the standard CRC32 known vector as an unsigned number", () => {
    expect(crc32(utf8Bytes("123456789"))).toBe(0xcbf43926);
  });

  it("computes CRC32 for a representative four-megabyte buffer", () => {
    const bytes = new Uint8Array(4 * 1024 * 1024);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index & 0xff;
    }

    expect(crc32(bytes)).toBe(0xc1d46223);
  });

  it("uses a table-driven CRC and incremental PNG structure checks", async () => {
    const source = await readFile(
      new URL("../../src/core/xmp/png.ts", import.meta.url),
      "utf8",
    );
    const crcImplementation = source.slice(
      source.indexOf("export function crc32"),
      source.indexOf("export function listPngChunks"),
    );

    expect(source).toContain("CRC32_TABLE");
    expect(crcImplementation).toContain("CRC32_TABLE");
    expect(crcImplementation).not.toMatch(/for\s*\(\s*let bit\b/);
    expect(source).toContain("export const MAX_PNG_CHUNKS = 16_384");
    expect(source).not.toContain("const ihdrChunks = chunks.filter");
    expect(source).not.toContain("const iendChunks = chunks.filter");
  });
});
