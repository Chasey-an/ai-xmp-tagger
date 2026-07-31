// @vitest-environment node

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SRGB2014_SHA256,
  getSrgb2014Profile,
} from "../../src/assets/srgb2014";
import { decodeRaster } from "../../src/core/conversion/decode";
import {
  encodeHighQualityJpeg,
  type RgbaImage,
} from "../../src/core/conversion/jpeg";
import { ProcessingError } from "../../src/core/errors";
import {
  concatBytes,
  minimalWebp,
  webpChunk,
} from "../helpers/binary-fixtures";

const encodeMock = vi.hoisted(() => vi.fn());
const initMock = vi.hoisted(() => vi.fn());

vi.mock("@jsquash/jpeg/encode.js", () => ({
  default: encodeMock,
  init: initMock,
}));

function fakeFile(bytes: Uint8Array, type: string): File {
  const copy = Uint8Array.from(bytes);
  return {
    name: "fixture",
    type,
    size: copy.length,
    arrayBuffer: async () => copy.buffer,
    slice: (start = 0, end = copy.length) =>
      fakeFile(copy.slice(start, end), type),
  } as unknown as File;
}

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(bytes.buffer).setUint32(8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function emptyPngChunk(type: string): Uint8Array {
  const bytes = new Uint8Array(12);
  bytes.set(new TextEncoder().encode(type), 4);
  return bytes;
}

function pngWithManyIdatChunks(count: number): Uint8Array {
  return concatBytes(
    pngHeader(1, 1),
    ...Array.from(
      { length: count },
      () => emptyPngChunk("IDAT"),
    ),
    emptyPngChunk("IEND"),
  );
}

function orientedPngHeader(
  width: number,
  height: number,
  orientation: number,
): Uint8Array {
  const tiff = new Uint8Array([
    0x49, 0x49, 0x2a, 0,
    8, 0, 0, 0,
    1, 0,
    0x12, 0x01,
    3, 0,
    1, 0, 0, 0,
    orientation, 0, 0, 0,
    0, 0, 0, 0,
  ]);
  const chunk = new Uint8Array(12 + tiff.length);
  new DataView(chunk.buffer).setUint32(0, tiff.length);
  chunk.set(new TextEncoder().encode("eXIf"), 4);
  chunk.set(tiff, 8);
  return concatBytes(pngHeader(width, height), chunk);
}

function simpleVp8Webp(width: number, height: number): Uint8Array {
  return minimalWebp([
    webpChunk("VP8 ", [
      0x10, 0, 0, 0x9d, 0x01, 0x2a,
      width & 0xff, (width >>> 8) & 0x3f,
      height & 0xff, (height >>> 8) & 0x3f,
    ]),
  ]);
}

function jpegSegment(marker: number, payload: readonly number[]): Uint8Array {
  const length = payload.length + 2;
  return new Uint8Array([
    0xff, marker, length >>> 8, length & 0xff, ...payload,
  ]);
}

function baselineJpeg(
  width: number,
  height: number,
  options: { progressive?: boolean; existingIcc?: boolean } = {},
): Uint8Array {
  const app0 = jpegSegment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0]);
  const oldIcc = jpegSegment(0xe2, [
    ...new TextEncoder().encode("ICC_PROFILE"),
    0,
    1,
    1,
    1,
    2,
    3,
  ]);
  const sof = jpegSegment(options.progressive ? 0xc2 : 0xc0, [
    8,
    height >>> 8,
    height & 0xff,
    width >>> 8,
    width & 0xff,
    3,
    1, 0x11, 0,
    2, 0x11, 1,
    3, 0x11, 1,
  ]);
  const sos = jpegSegment(0xda, [
    3,
    1, 0,
    2, 0x11,
    3, 0x11,
    0, 0x3f, 0,
  ]);
  return concatBytes(
    [0xff, 0xd8],
    app0,
    ...(options.existingIcc ? [oldIcc] : []),
    sof,
    sos,
    [1, 2, 3, 0xff, 0xd9],
  );
}

function collectIcc(jpeg: Uint8Array): Uint8Array {
  const chunks = new Map<number, Uint8Array>();
  let expectedTotal = 0;
  let offset = 2;
  while (offset + 4 <= jpeg.length && jpeg[offset] === 0xff) {
    const marker = jpeg[offset + 1]!;
    if (marker === 0xda) break;
    const length = jpeg[offset + 2]! * 0x100 + jpeg[offset + 3]!;
    const end = offset + 2 + length;
    if (
      marker === 0xe2 &&
      new TextDecoder().decode(jpeg.subarray(offset + 4, offset + 15)) ===
        "ICC_PROFILE" &&
      jpeg[offset + 15] === 0
    ) {
      const sequence = jpeg[offset + 16]!;
      expectedTotal = jpeg[offset + 17]!;
      chunks.set(sequence, jpeg.slice(offset + 18, end));
    }
    offset = end;
  }
  expect(chunks.size).toBe(expectedTotal);
  return concatBytes(
    ...Array.from({ length: expectedTotal }, (_, index) => chunks.get(index + 1)!),
  );
}

function alphaBmp(): Uint8Array {
  const bytes = new Uint8Array(14 + 40 + 16 + 4);
  const view = new DataView(bytes.buffer);
  bytes.set([0x42, 0x4d]);
  view.setUint32(2, bytes.length, true);
  view.setUint32(10, 70, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, 1, true);
  view.setInt32(22, 1, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 32, true);
  view.setUint32(30, 6, true);
  view.setUint32(34, 4, true);
  [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000].forEach(
    (mask, index) => view.setUint32(54 + index * 4, mask, true),
  );
  bytes.set([30, 20, 10, 128], 70);
  return bytes;
}

function animatedWebp(): Uint8Array {
  const vp8x = webpChunk("VP8X", [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const anim = webpChunk("ANIM", [0, 0, 0, 0, 0, 0]);
  const frameHeader = new Uint8Array(16);
  frameHeader[12] = 1;
  const vp8 = webpChunk("VP8 ", [
    0x10, 0, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0,
  ]);
  return minimalWebp([vp8x, anim, webpChunk("ANMF", concatBytes(frameHeader, vp8))]);
}

function expectErrorCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ProcessingError);
  expect(error).toMatchObject({ name: "ProcessingError", code });
}

class MockOffscreenCanvas {
  static instances: MockOffscreenCanvas[] = [];
  static imageData = {
    data: new Uint8ClampedArray([0, 0, 0, 255]),
  };
  static getImageDataFailure: unknown = null;
  readonly context = {
    fillStyle: "",
    fillRect: vi.fn(),
    setTransform: vi.fn(),
    drawImage: vi.fn(),
    getImageData: vi.fn(() => {
      if (MockOffscreenCanvas.getImageDataFailure !== null) {
        throw MockOffscreenCanvas.getImageDataFailure;
      }
      return MockOffscreenCanvas.imageData;
    }),
  };

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    MockOffscreenCanvas.instances.push(this);
  }

  getContext(type: string): typeof this.context | null {
    return type === "2d" ? this.context : null;
  }
}

beforeEach(() => {
  encodeMock.mockReset();
  initMock.mockReset();
  MockOffscreenCanvas.instances = [];
  MockOffscreenCanvas.imageData = {
    data: new Uint8ClampedArray([0, 0, 0, 255]),
  };
  MockOffscreenCanvas.getImageDataFailure = null;
  vi.stubGlobal("OffscreenCanvas", MockOffscreenCanvas);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("official sRGB2014 profile", () => {
  it("embeds the official bytes unchanged", () => {
    const profile = getSrgb2014Profile();
    expect(profile).toHaveLength(3024);
    expect(createHash("sha256").update(profile).digest("hex")).toBe(SRGB2014_SHA256);
  });
});

describe("decodeRaster", () => {
  it("accepts PNGs split across more than 256 consecutive IDAT chunks", async () => {
    const close = vi.fn();
    const createImageBitmapMock = vi.fn(async () => ({
      width: 1,
      height: 1,
      close,
    }));
    vi.stubGlobal("createImageBitmap", createImageBitmapMock);

    await expect(
      decodeRaster(
        fakeFile(pngWithManyIdatChunks(300), "image/png"),
        "png",
      ),
    ).resolves.toMatchObject({ width: 1, height: 1 });
    expect(createImageBitmapMock).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("decodes with exact browser options, white-flattens alpha, and closes the bitmap", async () => {
    const events: string[] = [];
    const close = vi.fn();
    close.mockImplementation(() => events.push("close"));
    const bitmap = { width: 2, height: 1, close };
    const createImageBitmapMock = vi.fn(async () => bitmap);
    vi.stubGlobal("createImageBitmap", createImageBitmapMock);
    const flattened = new Uint8ClampedArray([
      132, 137, 142, 255,
      255, 255, 255, 255,
    ]);
    MockOffscreenCanvas.imageData = {
      data: flattened,
    };

    const originalGetImageData =
      MockOffscreenCanvas.prototype.getContext;
    MockOffscreenCanvas.prototype.getContext = function (type: string) {
      const context = originalGetImageData.call(this, type);
      if (context !== null) {
        context.getImageData.mockImplementation(() => {
          events.push("getImageData");
          return MockOffscreenCanvas.imageData;
        });
      }
      return context;
    };
    const image = await decodeRaster(fakeFile(pngHeader(2, 1), "image/png"), "png");
    MockOffscreenCanvas.prototype.getContext = originalGetImageData;

    expect(createImageBitmapMock).toHaveBeenCalledWith(
      expect.anything(),
      {
        imageOrientation: "from-image",
        colorSpaceConversion: "default",
        premultiplyAlpha: "none",
      },
    );
    expect(MockOffscreenCanvas.instances[0]).toMatchObject({ width: 2, height: 1 });
    expect(MockOffscreenCanvas.instances[0]!.context.fillRect)
      .toHaveBeenCalledWith(0, 0, 2, 1);
    expect(image.data).toBe(flattened);
    expect(events).toEqual(["close", "getImageData"]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("decodes BMP directly and applies the same white composition", async () => {
    const createImageBitmapMock = vi.fn();
    vi.stubGlobal("createImageBitmap", createImageBitmapMock);
    const image = await decodeRaster(fakeFile(alphaBmp(), "image/bmp"), "bmp");
    expect(createImageBitmapMock).not.toHaveBeenCalled();
    expect([...image.data]).toEqual([132, 137, 142, 255]);
  });

  it("rejects animated WebP before platform decode with an actionable message", async () => {
    const createImageBitmapMock = vi.fn();
    vi.stubGlobal("createImageBitmap", createImageBitmapMock);
    await expect(
      decodeRaster(fakeFile(animatedWebp(), "image/webp"), "webp"),
    ).rejects.toSatisfy((error: unknown) => {
      expectErrorCode(error, "DECODE_FAILED");
      expect((error as Error).message).toContain("动态 WebP");
      return true;
    });
    expect(createImageBitmapMock).not.toHaveBeenCalled();
  });

  it("closes the bitmap and maps canvas failures with the original cause", async () => {
    const close = vi.fn();
    const platformFailure = new Error("canvas failed");
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1, height: 1, close })));
    MockOffscreenCanvas.getImageDataFailure = platformFailure;

    await expect(
      decodeRaster(fakeFile(pngHeader(1, 1), "image/png"), "png"),
    ).rejects.toSatisfy((error: unknown) => {
      expectErrorCode(error, "DECODE_FAILED");
      expect((error as Error).cause).toBe(platformFailure);
      return true;
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("checks the pixel cap before canvas allocation and still closes the bitmap", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({
      width: 40_000_001,
      height: 1,
      close,
    })));
    await expect(
      decodeRaster(fakeFile(pngHeader(1, 1), "image/png"), "png"),
    ).rejects.toSatisfy((error: unknown) => {
      expectErrorCode(error, "LIMIT_EXCEEDED");
      return true;
    });
    expect(MockOffscreenCanvas.instances).toHaveLength(0);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "PNG",
      format: "png",
      bytes: pngHeader(10_000, 5_000),
      type: "image/png",
    },
    {
      name: "WebP",
      format: "webp",
      bytes: simpleVp8Webp(16_383, 16_383),
      type: "image/webp",
    },
  ] as const)("rejects a huge $name header before createImageBitmap", async ({
    format,
    bytes,
    type,
  }) => {
    const createImageBitmapMock = vi.fn();
    vi.stubGlobal("createImageBitmap", createImageBitmapMock);
    await expect(
      decodeRaster(fakeFile(bytes, type), format),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(createImageBitmapMock).not.toHaveBeenCalled();
    expect(MockOffscreenCanvas.instances).toHaveLength(0);
  });

  it("rejects native decoded dimensions that differ from the trusted header", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({
      width: 1,
      height: 1,
      close,
    })));
    await expect(
      decodeRaster(fakeFile(pngHeader(2, 1), "image/png"), "png"),
    ).rejects.toMatchObject({ code: "DECODE_FAILED" });
    expect(close).toHaveBeenCalledOnce();
    expect(MockOffscreenCanvas.instances).toHaveLength(0);
  });

  it("explicitly rotates raw native pixels when EXIF orientation 6 was ignored", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({
      width: 2,
      height: 1,
      close,
    })));
    MockOffscreenCanvas.imageData = {
      data: new Uint8ClampedArray([
        255, 0, 0, 255,
        0, 255, 0, 255,
      ]),
    };
    const image = await decodeRaster(
      fakeFile(orientedPngHeader(2, 1, 6), "image/png"),
      "png",
    );
    expect(image).toMatchObject({ width: 1, height: 2 });
    expect(MockOffscreenCanvas.instances[0]!.context.setTransform)
      .toHaveBeenCalledWith(0, 1, -1, 0, 1, 0);
    expect(close).toHaveBeenCalledOnce();
  });

  it("accepts only the orientation-corrected swapped dimensions from native decode", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({
      width: 1,
      height: 2,
      close,
    })));
    await expect(decodeRaster(
      fakeFile(orientedPngHeader(2, 1, 6), "image/png"),
      "png",
    )).resolves.toMatchObject({ width: 1, height: 2 });
    expect(MockOffscreenCanvas.instances[0]!.context.setTransform)
      .not.toHaveBeenCalled();

    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({
      width: 3,
      height: 2,
      close,
    })));
    await expect(decodeRaster(
      fakeFile(orientedPngHeader(2, 1, 6), "image/png"),
      "png",
    )).rejects.toMatchObject({ code: "DECODE_FAILED" });
  });

  it("uses a raw fallback decode for same-dimension orientations", async () => {
    const firstClose = vi.fn();
    const rawClose = vi.fn();
    const createImageBitmapMock = vi.fn()
      .mockResolvedValueOnce({ width: 2, height: 1, close: firstClose })
      .mockResolvedValueOnce({ width: 2, height: 1, close: rawClose });
    vi.stubGlobal("createImageBitmap", createImageBitmapMock);

    await decodeRaster(
      fakeFile(orientedPngHeader(2, 1, 2), "image/png"),
      "png",
    );
    expect(createImageBitmapMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      {
        imageOrientation: "none",
        colorSpaceConversion: "default",
        premultiplyAlpha: "none",
      },
    );
    expect(MockOffscreenCanvas.instances[0]!.context.setTransform)
      .toHaveBeenCalledWith(-1, 0, 0, 1, 2, 0);
    expect(firstClose).toHaveBeenCalledOnce();
    expect(rawClose).toHaveBeenCalledOnce();
  });
});

describe("encodeHighQualityJpeg", () => {
  const image: RgbaImage = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]),
  };

  it("uses lossless-quality 4:4:4 options and replaces encoder ICC deterministically", async () => {
    const encoded = baselineJpeg(2, 1, { existingIcc: true });
    encodeMock.mockResolvedValue(encoded.buffer);
    const result = await encodeHighQualityJpeg(image);

    expect(encodeMock).toHaveBeenCalledWith(
      expect.objectContaining(image),
      {
        quality: 100,
        baseline: true,
        progressive: false,
        auto_subsample: false,
        chroma_subsample: 1,
        separate_chroma_quality: true,
        chroma_quality: 100,
      },
    );
    expect(result.subarray(0, 2)).toEqual(new Uint8Array([0xff, 0xd8]));
    expect(collectIcc(result)).toEqual(getSrgb2014Profile());
    expect(result.indexOf(0xc0)).toBeGreaterThan(0);
  });

  it("maps progressive or otherwise invalid encoder output to ENCODE_FAILED", async () => {
    encodeMock.mockResolvedValue(baselineJpeg(2, 1, { progressive: true }).buffer);
    await expect(encodeHighQualityJpeg(image)).rejects.toSatisfy((error: unknown) => {
      expectErrorCode(error, "ENCODE_FAILED");
      expect((error as Error).cause).toBeDefined();
      return true;
    });
  });

  it("validates dimensions, data length and the decoded-pixel cap before encoding", async () => {
    await expect(encodeHighQualityJpeg({ ...image, width: 0 })).rejects.toMatchObject({
      code: "ENCODE_FAILED",
    });
    await expect(encodeHighQualityJpeg({
      ...image,
      data: new Uint8ClampedArray(3),
    })).rejects.toMatchObject({ code: "ENCODE_FAILED" });
    await expect(encodeHighQualityJpeg({
      width: 40_000_001,
      height: 1,
      data: new Uint8ClampedArray(0),
    })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(encodeMock).not.toHaveBeenCalled();
  });
});
