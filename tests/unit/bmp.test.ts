// @vitest-environment node

import { describe, expect, it } from "vitest";

import { ProcessingError } from "../../src/core/errors";
import { decodeBmp } from "../../src/core/conversion/bmp";

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer).setUint16(offset, value, true);
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer).setUint32(offset, value, true);
}

function writeI32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer).setInt32(offset, value, true);
}

interface InfoBmpOptions {
  width: number;
  height: number;
  bpp: number;
  compression?: number;
  pixels: readonly number[];
  palette?: ReadonlyArray<readonly [number, number, number]>;
  masks?: readonly number[];
  dibSize?: 40 | 52 | 56 | 108 | 124;
  imageSize?: number;
  colorSpaceType?: number;
  profileData?: number;
  profileSize?: number;
}

function infoBmp(options: InfoBmpOptions): Uint8Array {
  const dibSize = options.dibSize ?? 40;
  const masks = options.masks ?? [];
  const externalMaskBytes =
    dibSize === 40 && (options.compression === 3 || options.compression === 6)
      ? masks.length * 4
      : 0;
  const palette = options.palette ?? [];
  const offset = 14 + dibSize + externalMaskBytes + palette.length * 4;
  const bytes = new Uint8Array(offset + options.pixels.length);
  bytes.set([0x42, 0x4d]);
  writeU32(bytes, 2, bytes.length);
  writeU32(bytes, 10, offset);
  writeU32(bytes, 14, dibSize);
  writeI32(bytes, 18, options.width);
  writeI32(bytes, 22, options.height);
  writeU16(bytes, 26, 1);
  writeU16(bytes, 28, options.bpp);
  writeU32(bytes, 30, options.compression ?? 0);
  writeU32(bytes, 34, options.imageSize ?? options.pixels.length);
  writeU32(bytes, 46, palette.length);
  if (dibSize >= 108) {
    writeU32(bytes, 70, options.colorSpaceType ?? 0);
  }
  if (dibSize >= 124) {
    writeU32(bytes, 126, options.profileData ?? 0);
    writeU32(bytes, 130, options.profileSize ?? 0);
  }

  if (dibSize === 40) {
    masks.forEach((mask, index) => writeU32(bytes, 54 + index * 4, mask));
  } else {
    masks.forEach((mask, index) => writeU32(bytes, 54 + index * 4, mask));
  }
  palette.forEach(([red, green, blue], index) => {
    bytes.set([blue, green, red, 0], 14 + dibSize + externalMaskBytes + index * 4);
  });
  bytes.set(options.pixels, offset);
  return bytes;
}

function coreBmp(
  width: number,
  height: number,
  bpp: number,
  palette: ReadonlyArray<readonly [number, number, number]>,
  pixels: readonly number[],
): Uint8Array {
  const offset = 14 + 12 + palette.length * 3;
  const bytes = new Uint8Array(offset + pixels.length);
  bytes.set([0x42, 0x4d]);
  writeU32(bytes, 2, bytes.length);
  writeU32(bytes, 10, offset);
  writeU32(bytes, 14, 12);
  writeU16(bytes, 18, width);
  writeU16(bytes, 20, height);
  writeU16(bytes, 22, 1);
  writeU16(bytes, 24, bpp);
  palette.forEach(([red, green, blue], index) => {
    bytes.set([blue, green, red], 26 + index * 3);
  });
  bytes.set(pixels, offset);
  return bytes;
}

function rgba(...pixels: ReadonlyArray<readonly [number, number, number, number]>): number[] {
  return pixels.flatMap((pixel) => [...pixel]);
}

function expectCode(
  bytes: Uint8Array,
  code: "CORRUPT_CONTAINER" | "LIMIT_EXCEEDED" | "UNSUPPORTED_FORMAT",
): void {
  try {
    decodeBmp(bytes);
    throw new Error("Expected decodeBmp to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ProcessingError);
    expect(error).toMatchObject({ code });
  }
}

describe("decodeBmp", () => {
  it("decodes CORE 1-bit indexed rows with DWORD padding", () => {
    const image = decodeBmp(coreBmp(
      2,
      1,
      1,
      [[0, 0, 0], [255, 255, 255]],
      [0x40, 0, 0, 0],
    ));
    expect(image).toMatchObject({ width: 2, height: 1 });
    expect([...image.data]).toEqual(rgba([0, 0, 0, 255], [255, 255, 255, 255]));
  });

  it.each([
    {
      name: "CORE 4-bit",
      bytes: coreBmp(
        2,
        1,
        4,
        Array.from({ length: 16 }, (_, index) =>
          [index, index + 1, index + 2] as const),
        [0x12, 0, 0, 0],
      ),
      expected: rgba([1, 2, 3, 255], [2, 3, 4, 255]),
    },
    {
      name: "CORE 8-bit",
      bytes: coreBmp(
        2,
        1,
        8,
        Array.from({ length: 256 }, (_, index) =>
          [index, 255 - index, index >>> 1] as const),
        [1, 2, 0, 0],
      ),
      expected: rgba([1, 254, 0, 255], [2, 253, 1, 255]),
    },
  ])("decodes $name palettes", ({ bytes, expected }) => {
    expect([...decodeBmp(bytes).data]).toEqual(expected);
  });

  it("decodes an INFO 1-bit indexed palette", () => {
    const image = decodeBmp(infoBmp({
      width: 2,
      height: 1,
      bpp: 1,
      palette: [[10, 20, 30], [40, 50, 60]],
      pixels: [0x80, 0, 0, 0],
    }));
    expect([...image.data]).toEqual(rgba(
      [40, 50, 60, 255],
      [10, 20, 30, 255],
    ));
  });

  it.each([
    {
      name: "4-bit indexed",
      bpp: 4,
      pixels: [0x12, 0, 0, 0],
      palette: [[0, 0, 0], [255, 0, 0], [0, 255, 0]] as const,
      expected: rgba([255, 0, 0, 255], [0, 255, 0, 255]),
    },
    {
      name: "8-bit indexed",
      bpp: 8,
      pixels: [1, 2, 0, 0],
      palette: [[0, 0, 0], [255, 0, 0], [0, 255, 0]] as const,
      expected: rgba([255, 0, 0, 255], [0, 255, 0, 255]),
    },
    {
      name: "24-bit BGR",
      bpp: 24,
      pixels: [0, 0, 255, 0, 255, 0, 0, 0],
      expected: rgba([255, 0, 0, 255], [0, 255, 0, 255]),
    },
    {
      name: "32-bit BGRX",
      bpp: 32,
      pixels: [0, 0, 255, 1, 0, 255, 0, 2],
      expected: rgba([255, 0, 0, 255], [0, 255, 0, 255]),
    },
  ])("decodes INFO $name pixels", ({ bpp, pixels, palette, expected }) => {
    const image = decodeBmp(infoBmp({
      width: 2,
      height: 1,
      bpp,
      pixels,
      ...(palette === undefined ? {} : { palette }),
    }));
    expect([...image.data]).toEqual(expected);
  });

  it("maps bottom-up and top-down rows to the same visual orientation", () => {
    const bottomUp = decodeBmp(infoBmp({
      width: 1,
      height: 2,
      bpp: 24,
      pixels: [255, 0, 0, 0, 0, 0, 255, 0],
    }));
    const topDown = decodeBmp(infoBmp({
      width: 1,
      height: -2,
      bpp: 24,
      pixels: [0, 0, 255, 0, 255, 0, 0, 0],
    }));
    expect([...bottomUp.data]).toEqual(rgba([255, 0, 0, 255], [0, 0, 255, 255]));
    expect(topDown.data).toEqual(bottomUp.data);
  });

  it("decodes default 5-5-5 and explicit 5-6-5 masks", () => {
    const rgb555 = decodeBmp(infoBmp({
      width: 1,
      height: 1,
      bpp: 16,
      pixels: [0, 0x7c, 0, 0],
    }));
    const rgb565 = decodeBmp(infoBmp({
      width: 1,
      height: 1,
      bpp: 16,
      compression: 3,
      masks: [0xf800, 0x07e0, 0x001f],
      pixels: [0xe0, 0x07, 0, 0],
    }));
    expect([...rgb555.data]).toEqual(rgba([255, 0, 0, 255]));
    expect([...rgb565.data]).toEqual(rgba([0, 255, 0, 255]));
  });

  it("preserves explicit alpha masks", () => {
    const image = decodeBmp(infoBmp({
      width: 1,
      height: 1,
      bpp: 32,
      compression: 6,
      masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000],
      pixels: [30, 20, 10, 128],
    }));
    expect([...image.data]).toEqual(rgba([10, 20, 30, 128]));
  });

  it("honors explicit BI_RGB alpha masks in V3/V4/V5-family headers", () => {
    for (const dibSize of [56, 108, 124] as const) {
      const image = decodeBmp(infoBmp({
        width: 1,
        height: 1,
        bpp: 32,
        dibSize,
        colorSpaceType: 0x73524742,
        masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000],
        pixels: [30, 20, 10, 64],
      }));
      expect([...image.data]).toEqual(rgba([10, 20, 30, 64]));
    }
  });

  it("decodes V4 BITFIELDS and V5 ALPHABITFIELDS masks", () => {
    const v4 = decodeBmp(infoBmp({
      width: 1,
      height: 1,
      bpp: 16,
      compression: 3,
      dibSize: 108,
      colorSpaceType: 0x73524742,
      masks: [0xf800, 0x07e0, 0x001f],
      pixels: [0xe0, 0x07, 0, 0],
    }));
    const v5 = decodeBmp(infoBmp({
      width: 1,
      height: 1,
      bpp: 32,
      compression: 6,
      dibSize: 124,
      colorSpaceType: 0x73524742,
      masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000],
      pixels: [30, 20, 10, 128],
    }));
    expect([...v4.data]).toEqual(rgba([0, 255, 0, 255]));
    expect([...v5.data]).toEqual(rgba([10, 20, 30, 128]));
  });

  it("accepts the documented Windows default sRGB color-space value", () => {
    const image = decodeBmp(infoBmp({
      width: 1,
      height: 1,
      bpp: 24,
      dibSize: 108,
      colorSpaceType: 0x57696e20,
      pixels: [3, 2, 1, 0],
    }));
    expect([...image.data]).toEqual(rgba([1, 2, 3, 255]));
  });

  it("accepts a conventional zero declared file size when accesses stay bounded", () => {
    const bytes = infoBmp({
      width: 1,
      height: 1,
      bpp: 24,
      pixels: [3, 2, 1, 0],
    });
    writeU32(bytes, 2, 0);
    expect([...decodeBmp(bytes).data]).toEqual(rgba([1, 2, 3, 255]));
  });

  it("decodes strict RLE8 encoded, absolute, EOL, delta and EOB commands", () => {
    const image = decodeBmp(infoBmp({
      width: 4,
      height: 2,
      bpp: 8,
      compression: 1,
      palette: [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]],
      pixels: [
        2, 1, 0, 2, 1, 0, 1, 2, 0, 0,
        0, 4, 3, 2, 1, 0, 0, 0,
        0, 1,
      ],
    }));
    expect([...image.data]).toEqual(rgba(
      [0, 0, 255, 255], [0, 255, 0, 255], [255, 0, 0, 255], [0, 0, 0, 255],
      [255, 0, 0, 255], [255, 0, 0, 255], [0, 0, 0, 255], [0, 255, 0, 255],
    ));
  });

  it("decodes strict RLE4 encoded and absolute commands with word padding", () => {
    const palette = Array.from({ length: 6 }, (_, value) =>
      [value * 10, value * 10, value * 10] as const);
    const image = decodeBmp(infoBmp({
      width: 5,
      height: 1,
      bpp: 4,
      compression: 2,
      palette,
      pixels: [2, 0x12, 0, 3, 0x34, 0x50, 0, 0, 0, 1],
    }));
    expect([...image.data]).toEqual(rgba(
      [10, 10, 10, 255],
      [20, 20, 20, 255],
      [30, 30, 30, 255],
      [40, 40, 40, 255],
      [50, 50, 50, 255],
    ));
  });

  it("rejects invalid headers, dimensions, offsets, masks and palettes", () => {
    const invalidSignature = infoBmp({ width: 1, height: 1, bpp: 24, pixels: [0, 0, 0, 0] });
    invalidSignature[0] = 0;
    expectCode(invalidSignature, "CORRUPT_CONTAINER");

    const huge = infoBmp({ width: 40_000_001, height: 1, bpp: 24, pixels: [] });
    expectCode(huge, "LIMIT_EXCEEDED");

    const overlappingMasks = infoBmp({
      width: 1,
      height: 1,
      bpp: 16,
      compression: 3,
      masks: [0x7c00, 0x03e0, 0x03ff],
      pixels: [0, 0, 0, 0],
    });
    expectCode(overlappingMasks, "CORRUPT_CONTAINER");

    const badPaletteIndex = infoBmp({
      width: 1,
      height: 1,
      bpp: 8,
      palette: [[0, 0, 0]],
      pixels: [1, 0, 0, 0],
    });
    expectCode(badPaletteIndex, "CORRUPT_CONTAINER");
  });

  it("rejects unsupported formats separately from malformed data", () => {
    expectCode(infoBmp({ width: 1, height: 1, bpp: 2, pixels: [0, 0, 0, 0] }), "UNSUPPORTED_FORMAT");
    expectCode(infoBmp({
      width: 1,
      height: -1,
      bpp: 8,
      compression: 1,
      palette: [[0, 0, 0]],
      pixels: [0, 1],
    }), "UNSUPPORTED_FORMAT");
  });

  it.each([
    {
      name: "truncated encoded command",
      compression: 1,
      width: 2,
      height: 1,
      pixels: [1],
    },
    {
      name: "truncated delta operands",
      compression: 1,
      width: 2,
      height: 1,
      pixels: [0, 2, 1],
    },
    {
      name: "delta x overflow",
      compression: 1,
      width: 2,
      height: 1,
      pixels: [0, 2, 2, 0, 0, 1],
    },
    {
      name: "delta y overflow",
      compression: 1,
      width: 2,
      height: 1,
      pixels: [0, 2, 0, 1, 0, 1],
    },
    {
      name: "truncated RLE8 absolute pixel data",
      compression: 1,
      width: 4,
      height: 1,
      pixels: [0, 4, 1, 2, 3],
    },
    {
      name: "missing RLE8 absolute pad byte",
      compression: 1,
      width: 3,
      height: 1,
      pixels: [0, 3, 1, 2, 3],
    },
    {
      name: "truncated RLE4 absolute pixel data",
      compression: 2,
      width: 5,
      height: 1,
      pixels: [0, 5, 0x12, 0x34],
    },
    {
      name: "missing RLE4 absolute pad byte",
      compression: 2,
      width: 5,
      height: 1,
      pixels: [0, 5, 0x12, 0x34, 0x50],
    },
    {
      name: "EOL beyond final row",
      compression: 1,
      width: 2,
      height: 1,
      pixels: [0, 0, 0, 0],
    },
    {
      name: "missing EOB",
      compression: 1,
      width: 2,
      height: 1,
      pixels: [1, 1],
    },
  ])("rejects $name", ({ compression, width, height, pixels }) => {
    const bpp = compression === 1 ? 8 : 4;
    expectCode(infoBmp({
      width,
      height,
      bpp,
      compression,
      palette: Array.from({ length: 16 }, (_, index) =>
        [index, index, index] as const),
      pixels,
    }), "CORRUPT_CONTAINER");
  });

  it.each([
    {
      name: "alpha mask overlapping RGB",
      masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0x00ff0000],
    },
    {
      name: "missing ALPHABITFIELDS alpha mask",
      masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0],
    },
  ])("rejects $name", ({ masks }) => {
    expectCode(infoBmp({
      width: 1,
      height: 1,
      bpp: 32,
      compression: 6,
      masks,
      pixels: [0, 0, 0, 0],
    }), "CORRUPT_CONTAINER");
  });

  it("rejects colorsUsed greater than the indexed bit depth permits", () => {
    const bytes = infoBmp({
      width: 1,
      height: 1,
      bpp: 1,
      palette: [[0, 0, 0], [255, 255, 255]],
      pixels: [0, 0, 0, 0],
    });
    writeU32(bytes, 46, 3);
    expectCode(bytes, "CORRUPT_CONTAINER");
  });

  it("restricts COREHEADER bit depth to the documented indexed and 24-bit forms", () => {
    expectCode(coreBmp(1, 1, 16, [], [0, 0, 0, 0]), "UNSUPPORTED_FORMAT");
  });

  it.each([
    { name: "calibrated RGB", colorSpaceType: 0 },
    { name: "linked profile", colorSpaceType: 0x4c494e4b },
    { name: "embedded profile", colorSpaceType: 0x4d424544 },
  ])("rejects V4 $name color space", ({ colorSpaceType }) => {
    expectCode(infoBmp({
      width: 1,
      height: 1,
      bpp: 24,
      dibSize: 108,
      colorSpaceType,
      pixels: [0, 0, 0, 0],
    }), "UNSUPPORTED_FORMAT");
  });

  it("rejects ambiguous nonzero V5 profile fields", () => {
    expectCode(infoBmp({
      width: 1,
      height: 1,
      bpp: 24,
      dibSize: 124,
      colorSpaceType: 0x73524742,
      profileData: 1,
      profileSize: 1,
      pixels: [0, 0, 0, 0],
    }), "UNSUPPORTED_FORMAT");
  });

  it("rejects a no-op RLE delta command", () => {
    expectCode(infoBmp({
      width: 1,
      height: 1,
      bpp: 8,
      compression: 1,
      palette: [[0, 0, 0]],
      pixels: [0, 2, 0, 0, 0, 1],
    }), "CORRUPT_CONTAINER");
  });

  it.each([
    {
      name: "declared file size mismatch",
      make: () => {
        const bytes = infoBmp({ width: 1, height: 1, bpp: 24, pixels: [0, 0, 0, 0] });
        writeU32(bytes, 2, bytes.length - 1);
        return bytes;
      },
    },
    {
      name: "truncated declared DIB",
      make: () => {
        const bytes = infoBmp({ width: 1, height: 1, bpp: 24, pixels: [0, 0, 0, 0] });
        writeU32(bytes, 14, 124);
        return bytes;
      },
    },
    {
      name: "pixel offset overlapping metadata",
      make: () => {
        const bytes = infoBmp({ width: 1, height: 1, bpp: 24, pixels: [0, 0, 0, 0] });
        writeU32(bytes, 10, 20);
        return bytes;
      },
    },
    {
      name: "truncated DWORD-aligned row",
      make: () => infoBmp({
        width: 1,
        height: 1,
        bpp: 24,
        imageSize: 0,
        pixels: [0, 0, 0],
      }),
    },
    {
      name: "non-contiguous bitfield mask",
      make: () => infoBmp({
        width: 1,
        height: 1,
        bpp: 16,
        compression: 3,
        masks: [0x7c00, 0x03e0, 0x0015],
        pixels: [0, 0, 0, 0],
      }),
    },
    {
      name: "bitfield mask outside pixel depth",
      make: () => infoBmp({
        width: 1,
        height: 1,
        bpp: 16,
        compression: 3,
        masks: [0x10000, 0x03e0, 0x001f],
        pixels: [0, 0, 0, 0],
      }),
    },
    {
      name: "palette table overlapping pixels",
      make: () => {
        const bytes = infoBmp({
          width: 1,
          height: 1,
          bpp: 8,
          palette: [[0, 0, 0]],
          pixels: [0, 0, 0, 0],
        });
        writeU32(bytes, 46, 2);
        return bytes;
      },
    },
    {
      name: "RLE stream without EOB",
      make: () => infoBmp({
        width: 1,
        height: 1,
        bpp: 8,
        compression: 1,
        palette: [[0, 0, 0], [255, 255, 255]],
        pixels: [1, 1],
      }),
    },
  ])("rejects $name", ({ make }) => {
    expectCode(make(), "CORRUPT_CONTAINER");
  });
});
