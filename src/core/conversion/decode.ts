import { MAX_DECODED_PIXELS } from "../constants";
import { ProcessingError } from "../errors";
import {
  orientationSwapsDimensions,
  readExifOrientation,
  type ExifOrientation,
} from "../exif-orientation";
import { inspectWebp } from "../xmp/webp";
import { decodeBmp, type RgbaImage } from "./bmp";

function decodeFailed(message: string, cause?: unknown): ProcessingError {
  return cause === undefined
    ? new ProcessingError("DECODE_FAILED", message)
    : new ProcessingError("DECODE_FAILED", message, { cause });
}

function validateDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw decodeFailed("图片解码后的尺寸无效，请确认文件未损坏。");
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels)) {
    throw decodeFailed("图片解码后的尺寸超出安全范围。");
  }
  if (pixels > MAX_DECODED_PIXELS) {
    throw new ProcessingError(
      "LIMIT_EXCEEDED",
      `图片解码后超过 ${MAX_DECODED_PIXELS.toLocaleString()} 像素上限。`,
    );
  }
}

function whiteComposeInPlace(image: RgbaImage): RgbaImage {
  validateDimensions(image.width, image.height);
  const expectedLength = image.width * image.height * 4;
  if (image.data.length !== expectedLength) {
    throw decodeFailed("图片解码后的像素数据长度无效。");
  }

  for (let offset = 0; offset < expectedLength; offset += 4) {
    const alpha = image.data[offset + 3]!;
    const inverseAlpha = 255 - alpha;
    image.data[offset] = Math.round(
      (image.data[offset]! * alpha + 255 * inverseAlpha) / 255,
    );
    image.data[offset + 1] = Math.round(
      (image.data[offset + 1]! * alpha + 255 * inverseAlpha) / 255,
    );
    image.data[offset + 2] = Math.round(
      (image.data[offset + 2]! * alpha + 255 * inverseAlpha) / 255,
    );
    image.data[offset + 3] = 255;
  }
  return image;
}

interface ExpectedDimensions {
  width: number;
  height: number;
  orientation: ExifOrientation;
}

function readU32Be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    bytes[offset + 1]! * 0x10000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  ) >>> 0;
}

async function inspectPng(file: File): Promise<ExpectedDimensions> {
  const bytes = new Uint8Array(await file.slice(0, 24).arrayBuffer());
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.length !== 24 ||
    signature.some((byte, index) => bytes[index] !== byte) ||
    readU32Be(bytes, 8) !== 13 ||
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    throw decodeFailed("PNG 文件头或 IHDR 尺寸信息无效。");
  }
  const dimensions: ExpectedDimensions = {
    width: readU32Be(bytes, 16),
    height: readU32Be(bytes, 20),
    orientation: await readPngOrientation(file),
  };
  validateDimensions(dimensions.width, dimensions.height);
  return dimensions;
}

const MAX_PNG_CHUNKS_FOR_ORIENTATION = 256;
const MAX_PNG_EXIF_BYTES = 64 * 1024;

async function readPngOrientation(file: File): Promise<ExifOrientation> {
  let offset = 8;
  for (
    let chunks = 0;
    offset < file.size && chunks < MAX_PNG_CHUNKS_FOR_ORIENTATION;
    chunks += 1
  ) {
    const header = new Uint8Array(
      await file.slice(offset, offset + 8).arrayBuffer(),
    );
    if (header.length !== 8) {
      throw decodeFailed("PNG 区块头已截断，无法安全读取方向信息。");
    }
    const length = readU32Be(header, 0);
    const chunkEnd = offset + 12 + length;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > file.size) {
      throw decodeFailed("PNG 区块长度无效，无法安全读取方向信息。");
    }
    const isExif =
      header[4] === 0x65 &&
      header[5] === 0x58 &&
      header[6] === 0x49 &&
      header[7] === 0x66;
    if (isExif) {
      if (length > MAX_PNG_EXIF_BYTES) {
        throw decodeFailed("PNG eXIf 方向元数据超过安全读取上限。");
      }
      const payload = new Uint8Array(
        await file.slice(offset + 8, offset + 8 + length).arrayBuffer(),
      );
      try {
        return readExifOrientation(payload);
      } catch (error) {
        throw decodeFailed("PNG eXIf 方向元数据无效。", error);
      }
    }
    offset = chunkEnd;
  }
  if (offset < file.size) {
    throw decodeFailed("PNG 区块数量过多，无法安全确定图片方向。");
  }
  return 1;
}

function orientedDimensions(expected: ExpectedDimensions): {
  width: number;
  height: number;
} {
  return orientationSwapsDimensions(expected.orientation)
    ? { width: expected.height, height: expected.width }
    : { width: expected.width, height: expected.height };
}

function applyOrientationTransform(
  context: OffscreenCanvasRenderingContext2D,
  orientation: ExifOrientation,
  width: number,
  height: number,
): void {
  const transforms: Record<
    ExifOrientation,
    readonly [number, number, number, number, number, number]
  > = {
    1: [1, 0, 0, 1, 0, 0],
    2: [-1, 0, 0, 1, width, 0],
    3: [-1, 0, 0, -1, width, height],
    4: [1, 0, 0, -1, 0, height],
    5: [0, 1, 1, 0, 0, 0],
    6: [0, 1, -1, 0, height, 0],
    7: [0, -1, -1, 0, height, width],
    8: [0, -1, 1, 0, 0, width],
  };
  context.setTransform(...transforms[orientation]);
}

async function decodeWithBrowser(
  file: File,
  expected: ExpectedDimensions,
): Promise<RgbaImage> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
      colorSpaceConversion: "default",
      premultiplyAlpha: "none",
    });
    validateDimensions(bitmap.width, bitmap.height);
    const oriented = orientedDimensions(expected);
    validateDimensions(oriented.width, oriented.height);
    const dimensionsAreAmbiguous =
      expected.orientation !== 1 &&
      expected.width === oriented.width &&
      expected.height === oriented.height;
    let explicitlyOrient = false;

    if (dimensionsAreAmbiguous) {
      bitmap.close();
      bitmap = null;
      bitmap = await createImageBitmap(file, {
        imageOrientation: "none",
        colorSpaceConversion: "default",
        premultiplyAlpha: "none",
      });
      validateDimensions(bitmap.width, bitmap.height);
      if (
        bitmap.width !== expected.width ||
        bitmap.height !== expected.height
      ) {
        throw decodeFailed("浏览器原始解码尺寸与可信文件头不一致。");
      }
      explicitlyOrient = true;
    } else {
      const nativeAppliedOrientation =
        bitmap.width === oriented.width && bitmap.height === oriented.height;
      const nativeReturnedRaw =
        bitmap.width === expected.width && bitmap.height === expected.height;
      explicitlyOrient =
        !nativeAppliedOrientation &&
        nativeReturnedRaw &&
        orientationSwapsDimensions(expected.orientation);
      if (!nativeAppliedOrientation && !explicitlyOrient) {
        throw decodeFailed("浏览器解码尺寸与可信文件头不一致。");
      }
    }

    const canvas = new OffscreenCanvas(oriented.width, oriented.height);
    const context = canvas.getContext("2d", { alpha: false });
    if (context === null) {
      throw decodeFailed("浏览器无法创建图片解码画布。");
    }
    context.fillStyle = "#fff";
    context.fillRect(0, 0, oriented.width, oriented.height);
    if (explicitlyOrient) {
      applyOrientationTransform(
        context,
        expected.orientation,
        expected.width,
        expected.height,
      );
    }
    context.drawImage(bitmap, 0, 0);
    const { width, height } = oriented;
    bitmap.close();
    bitmap = null;
    const pixels = context.getImageData(0, 0, width, height);
    return {
      data: pixels.data,
      width,
      height,
    };
  } finally {
    bitmap?.close();
  }
}

export async function decodeRaster(
  file: File,
  format: "png" | "webp" | "bmp",
): Promise<RgbaImage> {
  try {
    if (format === "bmp") {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return whiteComposeInPlace(decodeBmp(bytes));
    }

    let expected: ExpectedDimensions;
    if (format === "webp") {
      const inspection = inspectWebp(
        new Uint8Array(await file.arrayBuffer()),
      );
      validateDimensions(inspection.width, inspection.height);
      if (inspection.animated) {
        throw decodeFailed(
          "暂不支持动态 WebP，请先转换为静态 PNG、WebP 或 JPEG 后重试。",
        );
      }
      expected = inspection;
    } else {
      expected = await inspectPng(file);
    }

    return await decodeWithBrowser(file, expected);
  } catch (error) {
    if (error instanceof ProcessingError) {
      throw error;
    }
    throw decodeFailed("浏览器无法解码该图片，请确认文件完整且格式受支持。", error);
  }
}
