// @vitest-environment node

import { describe, expect, it } from "vitest";

import { MAX_XMP_BYTES } from "../../src/core/constants";
import { ProcessingError } from "../../src/core/errors";
import {
  MAX_WEBP_CHUNKS,
  isAnimatedWebp,
  listWebpChunks,
  readWebpXmp,
  writeWebpXmp,
} from "../../src/core/xmp/webp";
import {
  concatBytes,
  knownValidWebp1x1,
  minimalWebp,
  utf8Bytes,
  webpChunk,
} from "../helpers/binary-fixtures";

const VP8_START_CODE = [0x9d, 0x01, 0x2a] as const;

function vp8Data(width = 1, height = 1): Uint8Array {
  return new Uint8Array([
    0x10, 0x00, 0x00,
    ...VP8_START_CODE,
    width & 0xff, (width >>> 8) & 0x3f,
    height & 0xff, (height >>> 8) & 0x3f,
  ]);
}

function vp8lData(
  width = 1,
  height = 1,
  alpha = false,
  version = 0,
): Uint8Array {
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  const packed =
    widthMinusOne |
    (heightMinusOne << 14) |
    (alpha ? 1 << 28 : 0) |
    (version << 29);
  return new Uint8Array([
    0x2f,
    packed & 0xff,
    (packed >>> 8) & 0xff,
    (packed >>> 16) & 0xff,
    packed >>> 24,
  ]);
}

function vp8xData(
  flags = 0,
  width = 1,
  height = 1,
): Uint8Array {
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  return new Uint8Array([
    flags, 0, 0, 0,
    widthMinusOne & 0xff,
    (widthMinusOne >>> 8) & 0xff,
    (widthMinusOne >>> 16) & 0xff,
    heightMinusOne & 0xff,
    (heightMinusOne >>> 8) & 0xff,
    (heightMinusOne >>> 16) & 0xff,
  ]);
}

function writeUint24Le(
  bytes: Uint8Array,
  offset: number,
  value: number,
): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
}

interface AnmfFixtureOptions {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  duration?: number;
  flags?: number;
  image?: Uint8Array;
  alpha?: Uint8Array;
  nested?: Uint8Array;
}

function anmfData(options: AnmfFixtureOptions = {}): Uint8Array {
  const x = options.x ?? 0;
  const y = options.y ?? 0;
  const width = options.width ?? 1;
  const height = options.height ?? 1;
  if (x % 2 !== 0 || y % 2 !== 0) {
    throw new RangeError("ANMF fixture offsets must be even");
  }

  const header = new Uint8Array(16);
  writeUint24Le(header, 0, x / 2);
  writeUint24Le(header, 3, y / 2);
  writeUint24Le(header, 6, width - 1);
  writeUint24Le(header, 9, height - 1);
  writeUint24Le(header, 12, options.duration ?? 100);
  header[15] = options.flags ?? 0;

  const nested =
    options.nested ??
    concatBytes(
      options.alpha === undefined
        ? []
        : webpChunk("ALPH", options.alpha),
      options.image ?? webpChunk("VP8 ", vp8Data(width, height)),
    );
  return concatBytes(header, nested);
}

function animatedWebp(
  width = 10,
  height = 20,
  frames: readonly Uint8Array[] = [
    webpChunk("ANMF", anmfData({ width, height })),
  ],
): Uint8Array {
  return minimalWebp([
    webpChunk("VP8X", vp8xData(0x02, width, height)),
    webpChunk("ANIM", [0, 0, 0, 0, 0, 0]),
    ...frames,
  ]);
}

function distributedBudgetAnimatedWebp(options: {
  overByOne?: boolean;
  existingXmp?: boolean;
} = {}): Uint8Array {
  const frameCount = 64;
  const trailingUnknownsPerFrame = 250;
  const nestedUnknown = webpChunk("tail");
  const image = webpChunk("VP8 ", vp8Data());
  const frames = Array.from({ length: frameCount }, (_, frameIndex) => {
    const extra = options.overByOne && frameIndex === frameCount - 1 ? 1 : 0;
    return webpChunk(
      "ANMF",
      anmfData({
        nested: concatBytes(
          image,
          ...Array.from(
            { length: trailingUnknownsPerFrame + extra },
            () => nestedUnknown,
          ),
        ),
      }),
    );
  });
  const existingXmp = options.existingXmp
    ? webpChunk("XMP ", utf8Bytes("<old/>"))
    : null;
  const topLevelUnknownCount = existingXmp === null ? 254 : 253;
  const topLevelUnknown = webpChunk("TOP!");

  return minimalWebp([
    webpChunk("VP8X", vp8xData(existingXmp === null ? 0x02 : 0x06)),
    webpChunk("ANIM", [0, 0, 0, 0, 0, 0]),
    ...frames,
    ...(existingXmp === null ? [] : [existingXmp]),
    ...Array.from(
      { length: topLevelUnknownCount },
      () => topLevelUnknown,
    ),
  ]);
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! +
    bytes[offset + 1]! * 0x100 +
    bytes[offset + 2]! * 0x10000 +
    bytes[offset + 3]! * 0x1000000
  ) >>> 0;
}

function readUint24Le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! +
    bytes[offset + 1]! * 0x100 +
    bytes[offset + 2]! * 0x10000
  );
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
  expectProcessingError(() => listWebpChunks(input), "CORRUPT_CONTAINER");
  expectProcessingError(() => readWebpXmp(input), "CORRUPT_CONTAINER");
  expectProcessingError(
    () => writeWebpXmp(input, "<replacement/>"),
    "CORRUPT_CONTAINER",
  );
  expectProcessingError(() => isAnimatedWebp(input), "CORRUPT_CONTAINER");
}

function expectChunkBudgetRejected(input: Uint8Array): void {
  expectProcessingError(() => listWebpChunks(input), "LIMIT_EXCEEDED");
  expectProcessingError(() => readWebpXmp(input), "LIMIT_EXCEEDED");
  expectProcessingError(
    () => writeWebpXmp(input, "<replacement/>"),
    "LIMIT_EXCEEDED",
  );
  expectProcessingError(() => isAnimatedWebp(input), "LIMIT_EXCEEDED");
}

function simpleVp8(width = 1, height = 1): Uint8Array {
  return minimalWebp([webpChunk("VP8 ", vp8Data(width, height))]);
}

function simpleVp8l(
  width = 1,
  height = 1,
  alpha = false,
): Uint8Array {
  return minimalWebp([webpChunk("VP8L", vp8lData(width, height, alpha))]);
}

describe("WebP RIFF XMP", () => {
  it("writes and reads XMP in simple VP8, simple VP8L, and extended VP8X containers", () => {
    const inputs = [
      simpleVp8(17, 23),
      simpleVp8l(31, 47),
      minimalWebp([
        webpChunk("VP8X", vp8xData(0, 9, 11)),
        webpChunk("VP8 ", vp8Data(9, 11)),
      ]),
    ];

    for (const input of inputs) {
      const output = writeWebpXmp(input, "<x:xmpmeta>中文</x:xmpmeta>");
      const chunks = listWebpChunks(output);

      expect(readWebpXmp(output)).toBe("<x:xmpmeta>中文</x:xmpmeta>");
      expect(readUint32Le(output, 4)).toBe(output.length - 8);
      expect(chunks.filter(({ fourcc }) => fourcc === "XMP ")).toHaveLength(1);
      expect(chunks[0]).toMatchObject({ fourcc: "VP8X" });
      expect(chunks[0]!.data[0]! & 0x04).toBe(0x04);
    }
  });

  it("synthesizes first-position VP8X with exact VP8 dimensions", () => {
    const output = writeWebpXmp(simpleVp8(321, 1234), "<packet/>");
    const chunks = listWebpChunks(output);

    expect(chunks.map(({ fourcc }) => fourcc)).toEqual([
      "VP8X",
      "VP8 ",
      "XMP ",
    ]);
    expect(readUint24Le(chunks[0]!.data, 4) + 1).toBe(321);
    expect(readUint24Le(chunks[0]!.data, 7) + 1).toBe(1234);
    expect(chunks[0]!.data[0]).toBe(0x04);
  });

  it("synthesizes VP8X with exact VP8L dimensions and the alpha flag", () => {
    const output = writeWebpXmp(simpleVp8l(16_384, 8_193, true), "<packet/>");
    const vp8x = listWebpChunks(output)[0]!;

    expect(vp8x.fourcc).toBe("VP8X");
    expect(readUint24Le(vp8x.data, 4) + 1).toBe(16_384);
    expect(readUint24Le(vp8x.data, 7) + 1).toBe(8_193);
    expect(vp8x.data[0]! & 0x10).toBe(0x10);
    expect(vp8x.data[0]! & 0x04).toBe(0x04);
  });

  it("preserves every existing VP8X byte except setting the XMP flag", () => {
    const originalVp8x = vp8xData(0x81, 123, 456);
    const input = minimalWebp([
      webpChunk("VP8X", originalVp8x),
      webpChunk("VP8 ", vp8Data(123, 456)),
    ]);

    const output = writeWebpXmp(input, "<packet/>");
    const written = listWebpChunks(output)[0]!.data;

    expect(written[0]).toBe(originalVp8x[0]! | 0x04);
    expect(written.slice(1)).toEqual(originalVp8x.slice(1));
  });

  it("accepts a VP8X canvas whose pixel product is exactly uint32 max", () => {
    const width = 65_535;
    const height = 65_537;
    expect(width * height).toBe(0xffff_ffff);
    const input = animatedWebp(width, height, [
      webpChunk("ANMF", anmfData()),
    ]);

    expect(listWebpChunks(input).map(({ fourcc }) => fourcc)).toEqual([
      "VP8X", "ANIM", "ANMF",
    ]);
    expect(readWebpXmp(input)).toBeNull();
    expect(isAnimatedWebp(input)).toBe(true);

    const output = writeWebpXmp(input, "<boundary/>");
    expect(readWebpXmp(output)).toBe("<boundary/>");
    expect(isAnimatedWebp(output)).toBe(true);
  });

  it.each([
    [
      "static",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0, 65_536, 65_536)),
        webpChunk("VP8 ", vp8Data()),
      ]),
    ],
    [
      "animated",
      animatedWebp(65_536, 65_536, [
        webpChunk("ANMF", anmfData()),
      ]),
    ],
  ])("rejects a %s VP8X canvas containing 2^32 pixels", (_label, input) => {
    expect(65_536 * 65_536).toBe(0x1_0000_0000);
    expectContainerRejected(input);
  });

  it("preserves ICCP, EXIF, ALPH, image, and unknown chunks raw and inserts XMP before trailing unknown chunks", () => {
    const vp8x = webpChunk("VP8X", vp8xData(0x38, 10, 20));
    const iccp = webpChunk("ICCP", [1, 2, 3], 0x7f);
    const alph = webpChunk("ALPH", [13], 0x93);
    const image = webpChunk("VP8 ", vp8Data(10, 20));
    const exif = webpChunk("EXIF", [14, 15, 16], 0xe1);
    const unknown = webpChunk("zzZZ", [17, 18, 19], 0x55);
    const input = minimalWebp([
      vp8x, iccp, alph, image, exif, unknown,
    ]);

    const outputChunks = listWebpChunks(writeWebpXmp(input, "<new/>"));

    expect(outputChunks.map(({ fourcc }) => fourcc)).toEqual([
      "VP8X", "ICCP", "ALPH", "VP8 ", "EXIF", "XMP ", "zzZZ",
    ]);
    const preservedInput = listWebpChunks(input).slice(1).map(({ raw }) => raw);
    const preservedOutput = outputChunks
      .filter(({ fourcc }) => fourcc !== "VP8X" && fourcc !== "XMP ")
      .map(({ raw }) => raw);
    expect(preservedOutput).toEqual(preservedInput);
    expect(outputChunks.at(-1)!.raw).toEqual(unknown);
  });

  it("preserves a valid animated chunk sequence raw and inserts XMP after frames and EXIF", () => {
    const vp8x = webpChunk("VP8X", vp8xData(0x2a, 10, 20));
    const iccp = webpChunk("ICCP", [1, 2, 3], 0x7f);
    const anim = webpChunk("ANIM", [4, 5, 6, 7, 8, 9]);
    const anmf = webpChunk(
      "ANMF",
      anmfData({ width: 10, height: 20 }),
    );
    const exif = webpChunk("EXIF", [14, 15, 16], 0xe1);
    const unknown = webpChunk("zzZZ", [17, 18, 19], 0x55);
    const input = minimalWebp([vp8x, iccp, anim, anmf, exif, unknown]);

    const output = writeWebpXmp(input, "<new/>");
    const outputChunks = listWebpChunks(output);

    expect(outputChunks.map(({ fourcc }) => fourcc)).toEqual([
      "VP8X", "ICCP", "ANIM", "ANMF", "EXIF", "XMP ", "zzZZ",
    ]);
    expect(
      outputChunks
        .filter(({ fourcc }) => fourcc !== "VP8X" && fourcc !== "XMP ")
        .map(({ raw }) => raw),
    ).toEqual(listWebpChunks(input).slice(1).map(({ raw }) => raw));
    expect(isAnimatedWebp(output)).toBe(true);
  });

  it("accepts ordered static metadata with interleaved unknown chunks and preserves all non-XMP raw bytes", () => {
    const unknownBeforeIcc = webpChunk("u001", [1], 0x91);
    const iccp = webpChunk("ICCP", [2, 3]);
    const unknownBeforeImage = webpChunk("u002", [4, 5, 6], 0x92);
    const image = webpChunk("VP8 ", vp8Data(2, 3));
    const unknownBeforeExif = webpChunk("u003", [7, 8]);
    const exif = webpChunk("EXIF", [9, 10, 11], 0x93);
    const unknownBeforeXmp = webpChunk("u004", [12]);
    const xmp = webpChunk("XMP ", utf8Bytes("<old/>"));
    const trailingUnknown = webpChunk("u005", [13, 14, 15], 0x94);
    const input = minimalWebp([
      webpChunk("VP8X", vp8xData(0x2c, 2, 3)),
      unknownBeforeIcc,
      iccp,
      unknownBeforeImage,
      image,
      unknownBeforeExif,
      exif,
      unknownBeforeXmp,
      xmp,
      trailingUnknown,
    ]);
    const originalNonXmp = listWebpChunks(input)
      .filter(({ fourcc }) => fourcc !== "XMP ")
      .map(({ raw }) => raw);

    const output = writeWebpXmp(input, "<new/>");
    const outputNonXmp = listWebpChunks(output)
      .filter(({ fourcc }) => fourcc !== "XMP ")
      .map(({ raw }) => raw);

    expect(readWebpXmp(output)).toBe("<new/>");
    expect(outputNonXmp).toEqual(originalNonXmp);
  });

  it("accepts ordered animated metadata with interleaved unknown chunks and preserves all non-XMP raw bytes", () => {
    const iccp = webpChunk("ICCP", [1, 2, 3], 0x71);
    const anim = webpChunk("ANIM", [0, 0, 0, 0, 0, 0]);
    const firstFrame = webpChunk(
      "ANMF",
      anmfData({ width: 2, height: 3 }),
    );
    const secondFrame = webpChunk(
      "ANMF",
      anmfData({ x: 2, width: 2, height: 3 }),
    );
    const exif = webpChunk("EXIF", [4, 5, 6], 0x72);
    const xmp = webpChunk("XMP ", utf8Bytes("<old/>"));
    const input = minimalWebp([
      webpChunk("VP8X", vp8xData(0x2e, 4, 3)),
      iccp,
      webpChunk("u101", [7]),
      anim,
      firstFrame,
      webpChunk("u102", [8, 9]),
      secondFrame,
      exif,
      webpChunk("u103", [10, 11, 12], 0x73),
      xmp,
      webpChunk("u104", [13]),
    ]);
    const originalNonXmp = listWebpChunks(input)
      .filter(({ fourcc }) => fourcc !== "XMP ")
      .map(({ raw }) => raw);

    const output = writeWebpXmp(input, "<new/>");
    const outputNonXmp = listWebpChunks(output)
      .filter(({ fourcc }) => fourcc !== "XMP ")
      .map(({ raw }) => raw);

    expect(isAnimatedWebp(output)).toBe(true);
    expect(readWebpXmp(output)).toBe("<new/>");
    expect(outputNonXmp).toEqual(originalNonXmp);
  });

  it("synthesizes observable ICC, alpha, and EXIF flags", () => {
    const output = writeWebpXmp(
      minimalWebp([
        webpChunk("ICCP", [1]),
        webpChunk("ALPH", [2]),
        webpChunk("VP8 ", vp8Data(2, 3)),
        webpChunk("EXIF", [3]),
      ]),
      "<packet/>",
    );
    const flags = listWebpChunks(output)[0]!.data[0]!;

    expect(flags & 0x20).toBe(0x20);
    expect(flags & 0x10).toBe(0x10);
    expect(flags & 0x08).toBe(0x08);
    expect(flags & 0x04).toBe(0x04);
    expect(flags & 0x02).toBe(0);
  });

  it.each([
    [
      "duplicate ICCP in extended WebP",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0x20, 2, 3)),
        webpChunk("ICCP", [1]),
        webpChunk("ICCP", [2]),
        webpChunk("VP8 ", vp8Data(2, 3)),
      ]),
    ],
    [
      "duplicate EXIF in extended WebP",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0x08, 2, 3)),
        webpChunk("VP8 ", vp8Data(2, 3)),
        webpChunk("EXIF", [1]),
        webpChunk("EXIF", [2]),
      ]),
    ],
    [
      "duplicate ICCP in simple WebP",
      minimalWebp([
        webpChunk("ICCP", [1]),
        webpChunk("ICCP", [2]),
        webpChunk("VP8 ", vp8Data(2, 3)),
      ]),
    ],
    [
      "duplicate EXIF in simple WebP",
      minimalWebp([
        webpChunk("VP8 ", vp8Data(2, 3)),
        webpChunk("EXIF", [1]),
        webpChunk("EXIF", [2]),
      ]),
    ],
  ])("rejects %s", (_label, input) => {
    expectContainerRejected(input);
  });

  it("tolerates out-of-order extended static metadata and replaces XMP in place", () => {
    const oldXmp = webpChunk("XMP ", utf8Bytes("<old/>"));
    const exif = webpChunk("EXIF", [1, 2, 3], 0x71);
    const image = webpChunk("VP8 ", vp8Data(2, 3));
    const iccp = webpChunk("ICCP", [4, 5, 6], 0x72);
    const input = minimalWebp([
      webpChunk("VP8X", vp8xData(0x2c, 2, 3)),
      iccp,
      oldXmp,
      exif,
      image,
    ]);

    expect(readWebpXmp(input)).toBe("<old/>");
    const output = writeWebpXmp(input, "<new/>");
    const chunks = listWebpChunks(output);

    expect(chunks.map(({ fourcc }) => fourcc)).toEqual([
      "VP8X", "ICCP", "XMP ", "EXIF", "VP8 ",
    ]);
    expect(readWebpXmp(output)).toBe("<new/>");
    expect(chunks[1]!.raw).toEqual(iccp);
    expect(chunks[3]!.raw).toEqual(exif);
    expect(chunks[4]!.raw).toEqual(image);
  });

  it("tolerates out-of-order animated metadata and replaces XMP in place", () => {
    const oldXmp = webpChunk("XMP ", utf8Bytes("<old/>"));
    const exif = webpChunk("EXIF", [1, 2]);
    const anim = webpChunk("ANIM", [0, 0, 0, 0, 0, 0]);
    const frame = webpChunk(
      "ANMF",
      anmfData({ width: 2, height: 3 }),
    );
    const iccp = webpChunk("ICCP", [3, 4]);
    const input = minimalWebp([
      webpChunk("VP8X", vp8xData(0x2e, 2, 3)),
      iccp,
      oldXmp,
      exif,
      anim,
      frame,
    ]);

    expect(isAnimatedWebp(input)).toBe(true);
    expect(readWebpXmp(input)).toBe("<old/>");
    const output = writeWebpXmp(input, "<new/>");
    const chunks = listWebpChunks(output);

    expect(chunks.map(({ fourcc }) => fourcc)).toEqual([
      "VP8X", "ICCP", "XMP ", "EXIF", "ANIM", "ANMF",
    ]);
    expect(chunks.filter(({ fourcc }) => fourcc !== "XMP ").slice(1)
      .map(({ raw }) => raw)).toEqual([
      iccp, exif, anim, frame,
    ]);
  });

  it("tolerates out-of-order simple metadata while synthesis keeps existing XMP among original chunks", () => {
    const oldXmp = webpChunk("XMP ", utf8Bytes("<old/>"));
    const exif = webpChunk("EXIF", [1]);
    const image = webpChunk("VP8 ", vp8Data(2, 3));
    const iccp = webpChunk("ICCP", [2]);
    const input = minimalWebp([iccp, oldXmp, exif, image]);

    expect(readWebpXmp(input)).toBe("<old/>");
    const output = writeWebpXmp(input, "<new/>");
    const chunks = listWebpChunks(output);

    expect(chunks.map(({ fourcc }) => fourcc)).toEqual([
      "VP8X", "ICCP", "XMP ", "EXIF", "VP8 ",
    ]);
    expect(chunks.filter(({ fourcc }) => fourcc !== "XMP ").slice(1)
      .map(({ raw }) => raw)).toEqual([
      iccp, exif, image,
    ]);
  });

  it("inserts absent XMP after both out-of-order EXIF and image data", () => {
    const exif = webpChunk("EXIF", [1, 2]);
    const image = webpChunk("VP8 ", vp8Data(2, 3));
    const input = minimalWebp([
      webpChunk("VP8X", vp8xData(0x08, 2, 3)),
      exif,
      image,
    ]);

    const chunks = listWebpChunks(writeWebpXmp(input, "<new/>"));

    expect(chunks.map(({ fourcc }) => fourcc)).toEqual([
      "VP8X", "EXIF", "VP8 ", "XMP ",
    ]);
    expect(chunks[1]!.raw).toEqual(exif);
    expect(chunks[2]!.raw).toEqual(image);
  });

  it.each([
    [
      "ICCP after extended VP8",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0x20, 2, 3)),
        webpChunk("VP8 ", vp8Data(2, 3)),
        webpChunk("ICCP", [1]),
      ]),
    ],
    [
      "ICCP after extended VP8L",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0x20, 2, 3)),
        webpChunk("VP8L", vp8lData(2, 3)),
        webpChunk("ICCP", [1]),
      ]),
    ],
    [
      "ICCP after extended ALPH",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0x30, 2, 3)),
        webpChunk("ALPH", [0]),
        webpChunk("ICCP", [1]),
        webpChunk("VP8 ", vp8Data(2, 3)),
      ]),
    ],
    [
      "ICCP after simple VP8",
      minimalWebp([
        webpChunk("VP8 ", vp8Data(2, 3)),
        webpChunk("ICCP", [1]),
      ]),
    ],
    [
      "ICCP after simple VP8L",
      minimalWebp([
        webpChunk("VP8L", vp8lData(2, 3)),
        webpChunk("ICCP", [1]),
      ]),
    ],
    [
      "ICCP after simple ALPH",
      minimalWebp([
        webpChunk("ALPH", [0]),
        webpChunk("ICCP", [1]),
        webpChunk("VP8 ", vp8Data(2, 3)),
      ]),
    ],
    [
      "ICCP after ANIM",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0x22, 2, 3)),
        webpChunk("ANIM", [0, 0, 0, 0, 0, 0]),
        webpChunk("ICCP", [1]),
        webpChunk("ANMF", anmfData({ width: 2, height: 3 })),
      ]),
    ],
    [
      "ICCP after ANMF",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0x22, 2, 3)),
        webpChunk("ANIM", [0, 0, 0, 0, 0, 0]),
        webpChunk("ANMF", anmfData({ width: 2, height: 3 })),
        webpChunk("ICCP", [1]),
      ]),
    ],
  ])("rejects %s because color correction must precede image data", (_label, input) => {
    expectContainerRejected(input);
  });

  it.each([
    [
      "ICCP chunk without ICC flag",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0, 2, 3)),
        webpChunk("ICCP", [1]),
        webpChunk("VP8 ", vp8Data(2, 3)),
      ]),
    ],
    [
      "ICC flag without ICCP chunk",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0x20, 2, 3)),
        webpChunk("VP8 ", vp8Data(2, 3)),
      ]),
    ],
    [
      "EXIF chunk without EXIF flag",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0, 2, 3)),
        webpChunk("VP8 ", vp8Data(2, 3)),
        webpChunk("EXIF", [1]),
      ]),
    ],
    [
      "EXIF flag without EXIF chunk",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0x08, 2, 3)),
        webpChunk("VP8 ", vp8Data(2, 3)),
      ]),
    ],
    [
      "XMP chunk without XMP flag",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0, 2, 3)),
        webpChunk("VP8 ", vp8Data(2, 3)),
        webpChunk("XMP ", utf8Bytes("<packet/>")),
      ]),
    ],
    [
      "XMP flag without XMP chunk",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0x04, 2, 3)),
        webpChunk("VP8 ", vp8Data(2, 3)),
      ]),
    ],
  ])("rejects VP8X feature flag mismatch: %s", (_label, input) => {
    expectContainerRejected(input);
  });

  it("replaces existing XMP in its exact location without moving unaffected chunks", () => {
    const before = webpChunk("EXIF", [1, 2]);
    const oldXmp = webpChunk("XMP ", utf8Bytes("<old/>"));
    const after = webpChunk("zzZZ", [3, 4, 5], 0xaa);
    const input = minimalWebp([
      webpChunk("VP8X", vp8xData(0x0c, 1, 1)),
      webpChunk("VP8 ", vp8Data()),
      before,
      oldXmp,
      after,
    ]);

    const output = writeWebpXmp(input, "<replacement/>");
    const chunks = listWebpChunks(output);

    expect(chunks.map(({ fourcc }) => fourcc)).toEqual([
      "VP8X", "VP8 ", "EXIF", "XMP ", "zzZZ",
    ]);
    expect(readWebpXmp(output)).toBe("<replacement/>");
    expect(chunks[2]!.raw).toEqual(before);
    expect(chunks[4]!.raw).toEqual(after);
  });

  it("preserves arbitrary original odd-chunk pad bytes and writes a zero XMP pad", () => {
    const oddUnknown = webpChunk("odd!", [1, 2, 3], 0xab);
    const input = minimalWebp([
      webpChunk("VP8 ", vp8Data()),
      oddUnknown,
    ]);

    const output = writeWebpXmp(input, "abc");
    const chunks = listWebpChunks(output);
    const unknown = chunks.find(({ fourcc }) => fourcc === "odd!")!;
    const xmp = chunks.find(({ fourcc }) => fourcc === "XMP ")!;

    expect(unknown.raw).toEqual(oddUnknown);
    expect(xmp.raw).toEqual(
      concatBytes(utf8Bytes("XMP "), [3, 0, 0, 0], utf8Bytes("abc"), [0]),
    );
    expect(readUint32Le(output, 4)).toBe(output.length - 8);
  });

  it("lists exact FourCC, payload, and full raw chunk including a nonzero pad", () => {
    const chunk = webpChunk("odd!", [7, 8, 9], 0xfe);
    const listed = listWebpChunks(minimalWebp([chunk]))[0]!;

    expect(listed.fourcc).toBe("odd!");
    expect(listed.data).toEqual(new Uint8Array([7, 8, 9]));
    expect(listed.raw).toEqual(chunk);
  });

  it("rejects duplicate XMP and duplicate VP8X chunks", () => {
    const duplicateXmp = minimalWebp([
      webpChunk("VP8 ", vp8Data()),
      webpChunk("XMP ", utf8Bytes("<one/>")),
      webpChunk("XMP ", utf8Bytes("<two/>")),
    ]);
    const duplicateVp8x = minimalWebp([
      webpChunk("VP8X", vp8xData()),
      webpChunk("VP8X", vp8xData()),
      webpChunk("VP8 ", vp8Data()),
    ]);

    expectProcessingError(() => readWebpXmp(duplicateXmp), "XMP_CONFLICT");
    expectProcessingError(
      () => writeWebpXmp(duplicateXmp, "<replacement/>"),
      "XMP_CONFLICT",
    );
    expectProcessingError(
      () => writeWebpXmp(duplicateVp8x, "<replacement/>"),
      "CORRUPT_CONTAINER",
    );
  });

  it.each([
    ["short input", utf8Bytes("RIFF")],
    [
      "bad RIFF signature",
      concatBytes(utf8Bytes("RIFX"), [4, 0, 0, 0], utf8Bytes("WEBP")),
    ],
    [
      "bad WEBP type",
      concatBytes(utf8Bytes("RIFF"), [4, 0, 0, 0], utf8Bytes("WEPB")),
    ],
    [
      "RIFF size smaller than file",
      concatBytes(utf8Bytes("RIFF"), [4, 0, 0, 0], utf8Bytes("WEBP"), [0]),
    ],
    [
      "RIFF size larger than file",
      concatBytes(utf8Bytes("RIFF"), [5, 0, 0, 0], utf8Bytes("WEBP")),
    ],
    [
      "truncated chunk header",
      minimalWebp([]).slice(0, 11),
    ],
    [
      "truncated chunk data",
      minimalWebp([
        concatBytes(utf8Bytes("VP8 "), [5, 0, 0, 0], [1, 2]),
      ]),
    ],
    [
      "truncated odd chunk pad",
      minimalWebp([
        concatBytes(utf8Bytes("odd!"), [3, 0, 0, 0], [1, 2, 3]),
      ]),
    ],
    [
      "hostile uint32 chunk length",
      minimalWebp([
        concatBytes(utf8Bytes("huge"), [0xff, 0xff, 0xff, 0xff]),
      ]),
    ],
  ])("rejects %s as a corrupt container", (_label, input) => {
    expectContainerRejected(input);
  });

  it.each([
    ["VP8X is not first", [
      webpChunk("ICCP", [1]),
      webpChunk("VP8X", vp8xData()),
      webpChunk("VP8 ", vp8Data()),
    ]],
    ["VP8X is too short", [
      webpChunk("VP8X", vp8xData().slice(0, 9)),
      webpChunk("VP8 ", vp8Data()),
    ]],
    ["VP8X is too long", [
      webpChunk("VP8X", concatBytes(vp8xData(), [0])),
      webpChunk("VP8 ", vp8Data()),
    ]],
  ] as const)("rejects malformed %s", (_label, chunks) => {
    const input = minimalWebp(chunks);
    expectProcessingError(
      () => writeWebpXmp(input, "<replacement/>"),
      "CORRUPT_CONTAINER",
    );
    expectProcessingError(() => isAnimatedWebp(input), "CORRUPT_CONTAINER");
  });

  it.each([
    ["VP8 truncated key-frame header", webpChunk("VP8 ", vp8Data().slice(0, 9))],
    ["VP8 inter frame", webpChunk("VP8 ", concatBytes([0x11], vp8Data().slice(1)))],
    ["VP8 bad start code", webpChunk("VP8 ", concatBytes(vp8Data().slice(0, 3), [0, 1, 2], vp8Data().slice(6)))],
    ["VP8 zero width", webpChunk("VP8 ", vp8Data(0, 1))],
    ["VP8 zero height", webpChunk("VP8 ", vp8Data(1, 0))],
    ["VP8L truncated header", webpChunk("VP8L", vp8lData().slice(0, 4))],
    ["VP8L bad signature", webpChunk("VP8L", concatBytes([0x30], vp8lData().slice(1)))],
    ["VP8L unsupported version", webpChunk("VP8L", vp8lData(1, 1, false, 1))],
  ])("rejects malformed %s dimensions while synthesizing VP8X", (_label, image) => {
    expectProcessingError(
      () => writeWebpXmp(minimalWebp([image]), "<packet/>"),
      "CORRUPT_CONTAINER",
    );
  });

  it.each([
    [
      "VP8X-only static container",
      minimalWebp([webpChunk("VP8X", vp8xData(0, 2, 3))]),
    ],
    [
      "metadata-only static container",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0x20, 2, 3)),
        webpChunk("ICCP", [1, 2, 3]),
      ]),
    ],
    [
      "duplicate top-level VP8 images",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0, 2, 3)),
        webpChunk("VP8 ", vp8Data(2, 3)),
        webpChunk("VP8 ", vp8Data(2, 3)),
      ]),
    ],
    [
      "mixed top-level VP8 and VP8L images",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0, 2, 3)),
        webpChunk("VP8 ", vp8Data(2, 3)),
        webpChunk("VP8L", vp8lData(2, 3)),
      ]),
    ],
    [
      "malformed top-level image payload",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0, 2, 3)),
        webpChunk("VP8 ", vp8Data(2, 3).slice(0, 9)),
      ]),
    ],
    [
      "top-level image dimensions that disagree with the canvas",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0, 2, 3)),
        webpChunk("VP8 ", vp8Data(2, 4)),
      ]),
    ],
  ])("rejects %s as an undecodable extended static container", (_label, input) => {
    expectContainerRejected(input);
  });

  it("accepts a static extended VP8 image with optional ALPH before it", () => {
    const alph = webpChunk("ALPH", [0]);
    const image = webpChunk("VP8 ", vp8Data(2, 3));
    const input = minimalWebp([
      webpChunk("VP8X", vp8xData(0x10, 2, 3)),
      alph,
      image,
    ]);

    expect(listWebpChunks(input).map(({ fourcc }) => fourcc)).toEqual([
      "VP8X", "ALPH", "VP8 ",
    ]);
    expect(isAnimatedWebp(input)).toBe(false);
    const outputChunks = listWebpChunks(writeWebpXmp(input, "<packet/>"));
    expect(outputChunks.find(({ fourcc }) => fourcc === "ALPH")!.raw).toEqual(
      alph,
    );
    expect(outputChunks.find(({ fourcc }) => fourcc === "VP8 ")!.raw).toEqual(
      image,
    );
  });

  it.each([
    [
      "ALPH without the VP8X alpha flag",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0, 2, 3)),
        webpChunk("ALPH", [0]),
        webpChunk("VP8 ", vp8Data(2, 3)),
      ]),
    ],
    [
      "VP8X alpha flag without alpha data",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0x10, 2, 3)),
        webpChunk("VP8 ", vp8Data(2, 3)),
      ]),
    ],
    [
      "ALPH after the VP8 image",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0x10, 2, 3)),
        webpChunk("VP8 ", vp8Data(2, 3)),
        webpChunk("ALPH", [0]),
      ]),
    ],
    [
      "ALPH beside a VP8L image",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0x10, 2, 3)),
        webpChunk("ALPH", [0]),
        webpChunk("VP8L", vp8lData(2, 3, true)),
      ]),
    ],
    [
      "duplicate ALPH chunks",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0x10, 2, 3)),
        webpChunk("ALPH", [0]),
        webpChunk("ALPH", [0]),
        webpChunk("VP8 ", vp8Data(2, 3)),
      ]),
    ],
  ])("rejects static alpha flag/chunk inconsistency: %s", (_label, input) => {
    expectContainerRejected(input);
  });

  it.each([
    ["short ANIM payload", webpChunk("ANIM", [0, 0, 0, 0, 0])],
    ["long ANIM payload", webpChunk("ANIM", [0, 0, 0, 0, 0, 0, 0])],
  ])("rejects %s", (_label, anim) => {
    const input = minimalWebp([
      webpChunk("VP8X", vp8xData(0x02, 2, 3)),
      anim,
      webpChunk("ANMF", anmfData({ width: 2, height: 3 })),
    ]);
    expectContainerRejected(input);
  });

  it.each([
    [
      "animation chunks without a VP8X animation flag",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0, 2, 3)),
        webpChunk("ANIM", [0, 0, 0, 0, 0, 0]),
        webpChunk("ANMF", anmfData({ width: 2, height: 3 })),
      ]),
    ],
    [
      "animation chunks without VP8X",
      minimalWebp([
        webpChunk("ANIM", [0, 0, 0, 0, 0, 0]),
        webpChunk("ANMF", anmfData({ width: 2, height: 3 })),
      ]),
    ],
    [
      "animation flag without ANIM or ANMF chunks",
      minimalWebp([webpChunk("VP8X", vp8xData(0x02, 2, 3))]),
    ],
    [
      "animation flag and ANIM without a frame",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0x02, 2, 3)),
        webpChunk("ANIM", [0, 0, 0, 0, 0, 0]),
      ]),
    ],
    [
      "duplicate ANIM chunks",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0x02, 2, 3)),
        webpChunk("ANIM", [0, 0, 0, 0, 0, 0]),
        webpChunk("ANIM", [0, 0, 0, 0, 0, 0]),
        webpChunk("ANMF", anmfData({ width: 2, height: 3 })),
      ]),
    ],
    [
      "ANMF before ANIM",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0x02, 2, 3)),
        webpChunk("ANMF", anmfData({ width: 2, height: 3 })),
        webpChunk("ANIM", [0, 0, 0, 0, 0, 0]),
      ]),
    ],
    [
      "top-level image in an animated container",
      minimalWebp([
        webpChunk("VP8X", vp8xData(0x02, 2, 3)),
        webpChunk("ANIM", [0, 0, 0, 0, 0, 0]),
        webpChunk("ANMF", anmfData({ width: 2, height: 3 })),
        webpChunk("VP8 ", vp8Data(2, 3)),
      ]),
    ],
  ])("rejects animation topology inconsistency: %s", (_label, input) => {
    expectContainerRejected(input);
  });

  it.each([
    [
      "the former one-byte ANMF fixture",
      new Uint8Array([1]),
    ],
    [
      "a 16-byte frame header without an image",
      new Uint8Array(16),
    ],
    [
      "a truncated nested chunk header",
      anmfData({ nested: concatBytes(utf8Bytes("VP8 "), [1, 0]) }),
    ],
    [
      "a truncated nested chunk payload",
      anmfData({
        nested: concatBytes(utf8Bytes("VP8 "), [10, 0, 0, 0], [1, 2]),
      }),
    ],
    [
      "a missing nested odd-length pad byte",
      anmfData({
        nested: concatBytes(utf8Bytes("VP8 "), [3, 0, 0, 0], [1, 2, 3]),
      }),
    ],
    [
      "a hostile nested uint32 payload length",
      anmfData({
        nested: concatBytes(
          utf8Bytes("VP8 "),
          [0xff, 0xff, 0xff, 0xff],
        ),
      }),
    ],
    [
      "duplicate nested images",
      anmfData({
        width: 2,
        height: 3,
        nested: concatBytes(
          webpChunk("VP8 ", vp8Data(2, 3)),
          webpChunk("VP8L", vp8lData(2, 3)),
        ),
      }),
    ],
    [
      "nested ALPH after the image",
      anmfData({
        width: 2,
        height: 3,
        nested: concatBytes(
          webpChunk("VP8 ", vp8Data(2, 3)),
          webpChunk("ALPH", [0]),
        ),
      }),
    ],
    [
      "nested ALPH before VP8L",
      anmfData({
        width: 2,
        height: 3,
        nested: concatBytes(
          webpChunk("ALPH", [0]),
          webpChunk("VP8L", vp8lData(2, 3, true)),
        ),
      }),
    ],
    [
      "an unknown chunk before the nested image",
      anmfData({
        width: 2,
        height: 3,
        nested: concatBytes(
          webpChunk("JUNK", [1, 2]),
          webpChunk("VP8 ", vp8Data(2, 3)),
        ),
      }),
    ],
    [
      "an unknown chunk between nested ALPH and VP8",
      anmfData({
        width: 2,
        height: 3,
        nested: concatBytes(
          webpChunk("ALPH", [0]),
          webpChunk("JUNK", [1, 2]),
          webpChunk("VP8 ", vp8Data(2, 3)),
        ),
      }),
    ],
    [
      "a malformed nested VP8 image",
      anmfData({ nested: webpChunk("VP8 ", vp8Data().slice(0, 9)) }),
    ],
    [
      "nested image dimensions differing from the frame",
      anmfData({
        width: 2,
        height: 3,
        image: webpChunk("VP8 ", vp8Data(2, 4)),
      }),
    ],
    [
      "reserved ANMF flag bits",
      anmfData({ flags: 0x80 }),
    ],
  ])("rejects malformed ANMF containing %s", (_label, frameData) => {
    const input = minimalWebp([
      webpChunk("VP8X", vp8xData(0x02, 2, 3)),
      webpChunk("ANIM", [0, 0, 0, 0, 0, 0]),
      webpChunk("ANMF", frameData),
    ]);
    expectContainerRejected(input);
  });

  it("rejects an ANMF rectangle extending beyond the VP8X canvas", () => {
    const input = animatedWebp(10, 10, [
      webpChunk("ANMF", anmfData({ x: 2, width: 9, height: 10 })),
    ]);

    expectContainerRejected(input);
  });

  it("accepts valid bounded ANMF frames with VP8, ALPH plus VP8, and alpha VP8L payloads", () => {
    const frames = [
      webpChunk("ANMF", anmfData({ width: 2, height: 3 })),
      webpChunk(
        "ANMF",
        anmfData({
          x: 2,
          width: 2,
          height: 3,
          alpha: new Uint8Array([0]),
          image: webpChunk("VP8 ", vp8Data(2, 3)),
        }),
      ),
      webpChunk(
        "ANMF",
        anmfData({
          x: 4,
          width: 2,
          height: 3,
          image: webpChunk("VP8L", vp8lData(2, 3, true)),
        }),
      ),
    ];
    const input = minimalWebp([
      webpChunk("VP8X", vp8xData(0x12, 6, 3)),
      webpChunk("ANIM", [0, 0, 0, 0, 0, 0]),
      ...frames,
    ]);

    expect(listWebpChunks(input).filter(({ fourcc }) => fourcc === "ANMF"))
      .toHaveLength(3);
    expect(isAnimatedWebp(input)).toBe(true);
    expect(readWebpXmp(input)).toBeNull();
  });

  it("accepts and preserves multiple odd/even unknown chunks trailing the nested ANMF image", () => {
    const image = webpChunk("VP8 ", vp8Data(2, 3));
    const evenUnknown = webpChunk("EVEN", [1, 2]);
    const oddUnknown = webpChunk("ODD!", [3, 4, 5], 0xa7);
    const secondOddUnknown = webpChunk("tail", [6], 0x5c);
    const frame = webpChunk(
      "ANMF",
      anmfData({
        width: 2,
        height: 3,
        nested: concatBytes(
          image,
          evenUnknown,
          oddUnknown,
          secondOddUnknown,
        ),
      }),
    );
    const input = minimalWebp([
      webpChunk("VP8X", vp8xData(0x02, 2, 3)),
      webpChunk("ANIM", [0, 0, 0, 0, 0, 0]),
      frame,
    ]);

    expect(isAnimatedWebp(input)).toBe(true);
    const output = writeWebpXmp(input, "<packet/>");
    const outputFrame = listWebpChunks(output).find(
      ({ fourcc }) => fourcc === "ANMF",
    )!;
    expect(outputFrame.raw).toEqual(frame);
    expect(outputFrame.data.slice(16)).toEqual(
      concatBytes(image, evenUnknown, oddUnknown, secondOddUnknown),
    );
  });

  it.each([
    ["VP8X", webpChunk("VP8X", vp8xData(0, 2, 3))],
    ["ICCP", webpChunk("ICCP", [1])],
    ["ANIM", webpChunk("ANIM", [0, 0, 0, 0, 0, 0])],
    ["ANMF", webpChunk("ANMF", [1])],
    ["ALPH", webpChunk("ALPH", [0])],
    ["VP8 ", webpChunk("VP8 ", vp8Data(2, 3))],
    ["VP8L", webpChunk("VP8L", vp8lData(2, 3))],
    ["EXIF", webpChunk("EXIF", [2])],
    ["XMP ", webpChunk("XMP ", utf8Bytes("<nested/>"))],
  ])("rejects defined WebP %s chunks trailing an ANMF image", (_fourcc, trailing) => {
    const frame = webpChunk(
      "ANMF",
      anmfData({
        width: 2,
        height: 3,
        nested: concatBytes(
          webpChunk("VP8 ", vp8Data(2, 3)),
          trailing,
        ),
      }),
    );
    const input = minimalWebp([
      webpChunk("VP8X", vp8xData(0x02, 2, 3)),
      webpChunk("ANIM", [0, 0, 0, 0, 0, 0]),
      frame,
    ]);

    expectContainerRejected(input);
  });

  it("validates every ANMF after an earlier alpha frame", () => {
    const alphaFrame = webpChunk(
      "ANMF",
      anmfData({
        width: 2,
        height: 3,
        image: webpChunk("VP8L", vp8lData(2, 3, true)),
      }),
    );
    const malformedLaterFrame = webpChunk("ANMF", [1]);
    const input = minimalWebp([
      webpChunk("VP8X", vp8xData(0x12, 2, 3)),
      webpChunk("ANIM", [0, 0, 0, 0, 0, 0]),
      alphaFrame,
      malformedLaterFrame,
    ]);

    expectContainerRejected(input);
  });

  it("rejects synthesis when no simple VP8 or VP8L dimensions exist", () => {
    expectProcessingError(
      () => writeWebpXmp(minimalWebp([webpChunk("ICCP", [1])]), "<packet/>"),
      "CORRUPT_CONTAINER",
    );
  });

  it("roundtrips Chinese and preserves a leading UTF-8 BOM", () => {
    const packet = "\ufeff<x:xmpmeta>中文标签</x:xmpmeta>";
    const output = writeWebpXmp(simpleVp8(), packet);

    expect(readWebpXmp(output)).toBe(packet);
    expect(
      Array.from(
        listWebpChunks(output).find(({ fourcc }) => fourcc === "XMP ")!
          .data.slice(0, 3),
      ),
    ).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("rejects invalid UTF-8 in an existing XMP chunk", () => {
    const input = minimalWebp([
      webpChunk("VP8 ", vp8Data()),
      webpChunk("XMP ", [0xc3, 0x28]),
    ]);

    expectProcessingError(() => readWebpXmp(input), "INVALID_XMP");
    expectProcessingError(
      () => writeWebpXmp(input, "<replacement/>"),
      "INVALID_XMP",
    );
  });

  it("rejects a lone UTF-16 surrogate before encoding", () => {
    expectProcessingError(
      () => writeWebpXmp(simpleVp8(), "\ud800"),
      "INVALID_XMP",
    );
    expectProcessingError(
      () => writeWebpXmp(simpleVp8(), "\udc00"),
      "INVALID_XMP",
    );
  });

  it("accepts an XMP packet exactly MAX_XMP_BYTES long", () => {
    const packet = `${"a".repeat(MAX_XMP_BYTES - 3)}中`;
    expect(utf8Bytes(packet)).toHaveLength(MAX_XMP_BYTES);

    const output = writeWebpXmp(simpleVp8(), packet);

    expect(readWebpXmp(output)).toBe(packet);
  });

  it("rejects MAX_XMP_BYTES + 1 before decoding or allocating a replacement", () => {
    const oversizedPacket = `${"a".repeat(MAX_XMP_BYTES - 2)}中`;
    const oversizedExisting = new Uint8Array(MAX_XMP_BYTES + 1);
    oversizedExisting.fill(0x61);
    oversizedExisting[MAX_XMP_BYTES] = 0xff;
    expect(utf8Bytes(oversizedPacket)).toHaveLength(MAX_XMP_BYTES + 1);

    expectProcessingError(
      () => writeWebpXmp(simpleVp8(), oversizedPacket),
      "INVALID_XMP",
    );
    expectProcessingError(
      () =>
        readWebpXmp(
          minimalWebp([
            webpChunk("VP8 ", vp8Data()),
            webpChunk("XMP ", oversizedExisting),
          ]),
        ),
      "INVALID_XMP",
    );
  });

  it("detects animation from a validated VP8X flag or animation chunks", () => {
    expect(isAnimatedWebp(animatedWebp())).toBe(true);
    expect(isAnimatedWebp(simpleVp8())).toBe(false);
    expect(isAnimatedWebp(simpleVp8l())).toBe(false);
  });

  it("accepts exactly MAX_WEBP_CHUNKS and rejects one more", () => {
    const compact = webpChunk("tiny");
    const exact = minimalWebp(
      Array.from({ length: MAX_WEBP_CHUNKS }, () => compact),
    );
    const over = minimalWebp(
      Array.from({ length: MAX_WEBP_CHUNKS + 1 }, () => compact),
    );

    expect(listWebpChunks(exact)).toHaveLength(MAX_WEBP_CHUNKS);
    expectProcessingError(() => listWebpChunks(over), "LIMIT_EXCEEDED");
  });

  it("accepts an exact cumulative budget distributed across many ANMF frames", () => {
    const expectedChunkCount =
      2 + 64 + 64 * (1 + 250) + 254;
    expect(expectedChunkCount).toBe(MAX_WEBP_CHUNKS);
    const input = distributedBudgetAnimatedWebp();

    expect(listWebpChunks(input)).toHaveLength(320);
    expect(readWebpXmp(input)).toBeNull();
    expect(isAnimatedWebp(input)).toBe(true);
  });

  it("rejects cumulative budget plus one distributed across many ANMF frames", () => {
    const input = distributedBudgetAnimatedWebp({ overByOne: true });

    expectChunkBudgetRejected(input);
  });

  it("rejects inserting XMP when an exact cumulative budget would gain one chunk", () => {
    const input = distributedBudgetAnimatedWebp();

    expectProcessingError(
      () => writeWebpXmp(input, "<new/>"),
      "LIMIT_EXCEEDED",
    );
  });

  it("allows replacing XMP at the exact cumulative budget", () => {
    const input = distributedBudgetAnimatedWebp({ existingXmp: true });
    const output = writeWebpXmp(input, "<new/>");

    expect(listWebpChunks(output)).toHaveLength(320);
    expect(readWebpXmp(output)).toBe("<new/>");
    expect(isAnimatedWebp(output)).toBe(true);
  });

  it("does not reject an exact-limit replacement that does not add a chunk", () => {
    const compact = webpChunk("tiny");
    const input = minimalWebp([
      webpChunk("VP8X", vp8xData(0x04)),
      webpChunk("VP8 ", vp8Data()),
      ...Array.from({ length: MAX_WEBP_CHUNKS - 3 }, () => compact),
      webpChunk("XMP ", utf8Bytes("<old/>")),
    ]);

    expect(listWebpChunks(writeWebpXmp(input, "<new/>"))).toHaveLength(
      MAX_WEBP_CHUNKS,
    );
  });

  it("rejects adding synthesized VP8X and XMP beyond the chunk limit", () => {
    const compact = webpChunk("tiny");
    const input = minimalWebp([
      webpChunk("VP8 ", vp8Data()),
      ...Array.from({ length: MAX_WEBP_CHUNKS - 1 }, () => compact),
    ]);

    expectProcessingError(
      () => writeWebpXmp(input, "<new/>"),
      "LIMIT_EXCEEDED",
    );
  });

  it("roundtrips XMP through a hardcoded known-valid 1x1 WebP and preserves its VP8 chunk raw", () => {
    const input = knownValidWebp1x1();
    const originalChunks = listWebpChunks(input);

    const output = writeWebpXmp(input, "<real-webp>一像素</real-webp>");
    const outputVp8 = listWebpChunks(output).find(
      ({ fourcc }) => fourcc === "VP8 ",
    );

    expect(originalChunks.map(({ fourcc }) => fourcc)).toEqual(["VP8 "]);
    expect(readUint24Le(listWebpChunks(output)[0]!.data, 4) + 1).toBe(1);
    expect(readUint24Le(listWebpChunks(output)[0]!.data, 7) + 1).toBe(1);
    expect(readWebpXmp(output)).toBe("<real-webp>一像素</real-webp>");
    expect(outputVp8!.raw).toEqual(originalChunks[0]!.raw);
  });
});
