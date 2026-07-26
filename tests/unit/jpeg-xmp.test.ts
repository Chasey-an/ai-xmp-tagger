// @vitest-environment node

import decodeJpeg, { init as initJpegDecoder } from "@jsquash/jpeg/decode.js";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { ProcessingError } from "../../src/core/errors";
import {
  extractJpegScan,
  readJpegXmp,
  writeJpegXmp,
} from "../../src/core/xmp/jpeg";
import {
  concatBytes,
  jpegSegment,
  jpegStandalone,
  knownValidJpeg1x1,
  minimalJpeg,
  utf8Bytes,
} from "../helpers/binary-fixtures";

const STANDARD_XMP = utf8Bytes("http://ns.adobe.com/xap/1.0/\0");
const EXTENDED_XMP = utf8Bytes("http://ns.adobe.com/xmp/extension/\0");
const JFIF = jpegSegment(0xe0, concatBytes(utf8Bytes("JFIF\0"), [1, 2, 3]));
const EXIF = jpegSegment(0xe1, concatBytes(utf8Bytes("Exif\0\0"), [4, 5, 6]));
const ICC = jpegSegment(
  0xe2,
  concatBytes(utf8Bytes("ICC_PROFILE\0"), [1, 1, 7, 8]),
);
const jpegDecoderWasm = new URL(
  "../../node_modules/@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm",
  import.meta.url,
);
let jpegDecoderInitialization: Promise<void> | null = null;

function initializeJpegDecoder(): Promise<void> {
  jpegDecoderInitialization ??= readFile(jpegDecoderWasm).then(
    async (wasmBytes) => {
      await initJpegDecoder(
        await WebAssembly.compile(Uint8Array.from(wasmBytes)),
      );
    },
  );
  return jpegDecoderInitialization;
}

function xmpSegment(packet: string): Uint8Array {
  return jpegSegment(0xe1, concatBytes(STANDARD_XMP, utf8Bytes(packet)));
}

function extendedXmpSegment(payload = [0x01]): Uint8Array {
  return jpegSegment(0xe1, concatBytes(EXTENDED_XMP, payload));
}

function expectProcessingError(
  operation: () => unknown,
  code:
    | "CORRUPT_CONTAINER"
    | "INVALID_XMP"
    | "XMP_CONFLICT"
    | "EXTENDED_XMP_UNSUPPORTED",
): void {
  try {
    operation();
    throw new Error("Expected operation to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ProcessingError);
    expect(error).toMatchObject({ name: "ProcessingError", code });
  }
}

function occurrences(haystack: Uint8Array, needle: Uint8Array): number {
  let count = 0;

  for (let offset = 0; offset <= haystack.length - needle.length; offset += 1) {
    if (needle.every((byte, index) => haystack[offset + index] === byte)) {
      count += 1;
    }
  }

  return count;
}

describe("lossless JPEG XMP", () => {
  it("streams a hostile count of standalone markers without retaining a segment array", async () => {
    const markerCount = 100_000;
    const markers = new Uint8Array(markerCount * 2);
    for (let offset = 0; offset < markers.length; offset += 2) {
      markers[offset] = 0xff;
      markers[offset + 1] = 0xd0;
    }
    const input = minimalJpeg([markers]);

    const output = writeJpegXmp(input, "<streamed/>");

    expect(readJpegXmp(output)).toBe("<streamed/>");
    expect(extractJpegScan(output)).toEqual(extractJpegScan(input));

    const source = await readFile(
      new URL("../../src/core/xmp/jpeg.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/segments\s*:\s*JpegSegment\[\]/);
    expect(source).not.toContain("segments.push(");
  });

  it("writes XMP losslessly into a known-valid decodable 1x1 JPEG", async () => {
    await initializeJpegDecoder();
    const input = knownValidJpeg1x1();
    const packet = "<baseline>真实图像</baseline>";
    const decodedInput = await decodeJpeg(Uint8Array.from(input).buffer);

    const output = writeJpegXmp(input, packet);
    const decodedOutput = await decodeJpeg(Uint8Array.from(output).buffer);

    expect(decodedInput).toMatchObject({ width: 1, height: 1 });
    expect(decodedOutput).toMatchObject({ width: 1, height: 1 });
    expect(readJpegXmp(output)).toBe(packet);
    expect(extractJpegScan(output)).toEqual(extractJpegScan(input));
  });

  it("inserts a standard XMP APP1 after contiguous Exif and ICC metadata", () => {
    const input = minimalJpeg([EXIF, ICC]);
    const packet = "<x:xmpmeta>target</x:xmpmeta>";

    const output = writeJpegXmp(input, packet);

    expect(readJpegXmp(output)).toBe(packet);
    expect(output.slice(0, 2 + EXIF.length + ICC.length)).toEqual(
      concatBytes([0xff, 0xd8], EXIF, ICC),
    );
    expect(
      output.slice(
        2 + EXIF.length + ICC.length,
        2 + EXIF.length + ICC.length + xmpSegment(packet).length,
      ),
    ).toEqual(xmpSegment(packet));
  });

  it("inserts after contiguous JFIF, Exif, and ICC segments with repeated FF fill bytes", () => {
    const jfifWithFill = concatBytes([0xff, 0xff], JFIF);
    const exifWithFill = concatBytes([0xff], EXIF);
    const iccWithFill = concatBytes([0xff, 0xff, 0xff], ICC);
    const input = minimalJpeg([
      jfifWithFill,
      exifWithFill,
      iccWithFill,
    ]);
    const packet = "<filled-prefixes/>";

    const output = writeJpegXmp(input, packet);

    expect(output).toEqual(
      concatBytes(
        [0xff, 0xd8],
        jfifWithFill,
        exifWithFill,
        iccWithFill,
        xmpSegment(packet),
        extractJpegScan(input),
      ),
    );
    expect(extractJpegScan(output)).toEqual(extractJpegScan(input));
  });

  it("preserves the SOS marker, header, entropy bytes, and EOI exactly", () => {
    const entropy = new Uint8Array([
      0x33,
      0xff,
      0x00,
      0xda,
      0xff,
      0xe1,
      0x00,
      0x02,
      0xff,
      0xd8,
      0x44,
    ]);
    const input = minimalJpeg([EXIF], entropy);
    const output = writeJpegXmp(input, "<packet/>");

    expect(extractJpegScan(output)).toEqual(extractJpegScan(input));
  });

  it("replaces one existing standard packet without creating a duplicate", () => {
    const unknown = jpegSegment(0xed, [9, 8, 7]);
    const input = minimalJpeg([JFIF, xmpSegment("<old/>"), unknown]);

    const output = writeJpegXmp(input, "<new/>");

    expect(readJpegXmp(output)).toBe("<new/>");
    expect(occurrences(output, STANDARD_XMP)).toBe(1);
    expect(occurrences(output, utf8Bytes("<old/>"))).toBe(0);
    expect(occurrences(output, unknown)).toBe(1);
  });

  it("rejects duplicate standard XMP packets with XMP_CONFLICT", () => {
    const input = minimalJpeg([
      xmpSegment("<first/>"),
      xmpSegment("<second/>"),
    ]);

    expectProcessingError(() => readJpegXmp(input), "XMP_CONFLICT");
    expectProcessingError(
      () => writeJpegXmp(input, "<replacement/>"),
      "XMP_CONFLICT",
    );
  });

  it("rejects any Extended XMP APP1 with EXTENDED_XMP_UNSUPPORTED", () => {
    const input = minimalJpeg([xmpSegment("<standard/>"), extendedXmpSegment()]);

    expectProcessingError(
      () => readJpegXmp(input),
      "EXTENDED_XMP_UNSUPPORTED",
    );
    expectProcessingError(
      () => writeJpegXmp(input, "<replacement/>"),
      "EXTENDED_XMP_UNSUPPORTED",
    );
  });

  it.each([
    [
      "later in an APP1 payload",
      jpegSegment(0xe1, concatBytes([0x10, 0x20], EXTENDED_XMP, [0x30])),
    ],
    [
      "inside another length-bearing segment",
      jpegSegment(0xdb, concatBytes([0x40], EXTENDED_XMP, [0x50])),
    ],
  ])(
    "rejects an Extended XMP signature %s",
    (_label, segmentWithExtendedSignature) => {
      const input = minimalJpeg([segmentWithExtendedSignature]);

      expectProcessingError(
        () => readJpegXmp(input),
        "EXTENDED_XMP_UNSUPPORTED",
      );
      expectProcessingError(
        () => writeJpegXmp(input, "<replacement/>"),
        "EXTENDED_XMP_UNSUPPORTED",
      );
    },
  );

  it("preserves JFIF, Exif, ICC, unknown APP, and structural segments", () => {
    const unknownApp = jpegSegment(0xee, [0x10, 0x20, 0x30]);
    const quantization = jpegSegment(0xdb, [0x00, 0x01, 0x02, 0x03]);
    const input = minimalJpeg([JFIF, EXIF, ICC, unknownApp, quantization]);

    const output = writeJpegXmp(input, "<packet/>");

    expect(output).toEqual(
      concatBytes(
        [0xff, 0xd8],
        JFIF,
        EXIF,
        ICC,
        xmpSegment("<packet/>"),
        unknownApp,
        quantization,
        extractJpegScan(input),
      ),
    );
  });

  it("inserts before the first unrecognized segment and does not skip later metadata", () => {
    const unknownApp = jpegSegment(0xef, [0xaa]);
    const input = minimalJpeg([JFIF, EXIF, unknownApp, ICC]);
    const inserted = xmpSegment("<placed/>");

    const output = writeJpegXmp(input, "<placed/>");
    const expectedPrefix = concatBytes(
      [0xff, 0xd8],
      JFIF,
      EXIF,
      inserted,
      unknownApp,
      ICC,
    );

    expect(output.slice(0, expectedPrefix.length)).toEqual(expectedPrefix);
  });

  it.each([
    ["bad SOI", new Uint8Array([0xff, 0xd9]), "read"],
    ["truncated marker", new Uint8Array([0xff, 0xd8, 0xff]), "read"],
    [
      "truncated length",
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]),
      "read",
    ],
    [
      "segment length below two",
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]),
      "read",
    ],
    [
      "payload outside the buffer",
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x08, 0x01]),
      "read",
    ],
    [
      "missing SOS",
      concatBytes([0xff, 0xd8], jpegSegment(0xe0, [1]), [0xff, 0xd9]),
      "read",
    ],
    [
      "unexpected non-marker data",
      concatBytes([0xff, 0xd8], [0x42], minimalJpeg().slice(2)),
      "read",
    ],
  ])("rejects %s as CORRUPT_CONTAINER", (_label, input) => {
    expectProcessingError(
      () => readJpegXmp(input as Uint8Array),
      "CORRUPT_CONTAINER",
    );
    expectProcessingError(
      () => extractJpegScan(input as Uint8Array),
      "CORRUPT_CONTAINER",
    );
  });

  it("accepts the exact APP1 packet limit and rejects one UTF-8 byte over", () => {
    const input = minimalJpeg();
    const maximumPacketBytes = 0xffff - 2 - STANDARD_XMP.length;
    const exactLimit = `${"a".repeat(maximumPacketBytes - 3)}中`;
    const oneByteOver = `${"a".repeat(maximumPacketBytes - 2)}中`;

    expect(utf8Bytes(exactLimit)).toHaveLength(maximumPacketBytes);
    expect(utf8Bytes(oneByteOver)).toHaveLength(maximumPacketBytes + 1);

    const output = writeJpegXmp(input, exactLimit);
    expect(output[4]).toBe(0xff);
    expect(output[5]).toBe(0xff);
    expect(readJpegXmp(output)).toBe(exactLimit);

    expectProcessingError(
      () => writeJpegXmp(input, oneByteOver),
      "INVALID_XMP",
    );
  });

  it("round-trips UTF-8 packet text including Chinese and non-ASCII", () => {
    const packet =
      '<x:xmpmeta><rdf:Description>中文 café — 🎨</rdf:Description></x:xmpmeta>';

    const output = writeJpegXmp(minimalJpeg([JFIF]), packet);

    expect(readJpegXmp(output)).toBe(packet);
  });

  it("preserves a leading UTF-8 BOM through read and replacement", () => {
    const packet = '\uFEFF<x:xmpmeta xmlns:x="adobe:ns:meta/"/>';
    const input = minimalJpeg([xmpSegment(packet)]);

    const readPacket = readJpegXmp(input);
    const output = writeJpegXmp(input, readPacket ?? "");

    expect(readPacket).toBe(packet);
    expect(readJpegXmp(output)).toBe(packet);
    expect(extractJpegScan(output)).toEqual(extractJpegScan(input));
  });

  it("rejects malformed UTF-8 in a standard packet as INVALID_XMP", () => {
    const invalidPacket = jpegSegment(
      0xe1,
      concatBytes(STANDARD_XMP, [0xc3, 0x28]),
    );

    expectProcessingError(
      () => readJpegXmp(minimalJpeg([invalidPacket])),
      "INVALID_XMP",
    );
    expectProcessingError(
      () => writeJpegXmp(minimalJpeg([invalidPacket]), "<replacement/>"),
      "INVALID_XMP",
    );
  });

  it("accepts standalone SOI, RST, and TEM markers before SOS without consuming lengths", () => {
    const standaloneMarkers = [
      jpegStandalone(0xd8),
      jpegStandalone(0xd0),
      jpegStandalone(0xd7),
      jpegStandalone(0x01),
    ];
    const standaloneBytes = concatBytes(...standaloneMarkers);
    const input = minimalJpeg([...standaloneMarkers, EXIF]);

    const output = writeJpegXmp(input, "<standalone/>");

    expect(readJpegXmp(output)).toBe("<standalone/>");
    expect(extractJpegScan(output)).toEqual(extractJpegScan(input));
    const inserted = xmpSegment("<standalone/>");
    expect(output.slice(2, 2 + inserted.length)).toEqual(inserted);
    expect(
      output.slice(
        2 + inserted.length,
        2 + inserted.length + standaloneBytes.length,
      ),
    ).toEqual(standaloneBytes);
  });

  it("treats marker-looking bytes after SOS as opaque, including XMP signatures", () => {
    const fakeExtended = concatBytes(
      [0xff, 0xe1, 0x00, EXTENDED_XMP.length + 2],
      EXTENDED_XMP,
    );
    const input = minimalJpeg([], concatBytes([0x11], fakeExtended, [0x22]));

    expect(readJpegXmp(input)).toBeNull();
    expect(() => writeJpegXmp(input, "<real/>")).not.toThrow();
    expect(extractJpegScan(writeJpegXmp(input, "<real/>"))).toEqual(
      extractJpegScan(input),
    );
  });
});
