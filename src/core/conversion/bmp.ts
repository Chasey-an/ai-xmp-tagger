import { MAX_DECODED_PIXELS } from "../constants";
import { ProcessingError } from "../errors";

export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const FILE_HEADER_BYTES = 14;
const CORE_HEADER_BYTES = 12;
const WINDOWS_DIB_SIZES = new Set([40, 52, 56, 108, 124]);

const BI_RGB = 0;
const BI_RLE8 = 1;
const BI_RLE4 = 2;
const BI_BITFIELDS = 3;
const BI_ALPHABITFIELDS = 6;
const LCS_SRGB = 0x73524742;
// Microsoft documents this legacy value as the Windows default color space,
// which is sRGB for these bitmap headers.
const LCS_WINDOWS_COLOR_SPACE = 0x57696e20;

interface ChannelMask {
  mask: number;
  shift: number;
  maximum: number;
}

interface PixelMasks {
  red: ChannelMask;
  green: ChannelMask;
  blue: ChannelMask;
  alpha: ChannelMask | null;
}

type PaletteEntry = readonly [red: number, green: number, blue: number];

function corrupt(message: string): ProcessingError {
  return new ProcessingError("CORRUPT_CONTAINER", message);
}

function unsupported(message: string): ProcessingError {
  return new ProcessingError("UNSUPPORTED_FORMAT", message);
}

function requireBytes(
  bytes: Uint8Array,
  offset: number,
  length: number,
  message: string,
  limit = bytes.length,
): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > limit ||
    length > limit - offset
  ) {
    throw corrupt(message);
  }
}

function checkedAdd(left: number, right: number, message: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw corrupt(message);
  }
  return result;
}

function checkedMultiply(left: number, right: number, message: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw corrupt(message);
  }
  return result;
}

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function readI32(view: DataView, offset: number): number {
  return view.getInt32(offset, true);
}

function parseChannelMask(mask: number, bitsPerPixel: number): ChannelMask {
  const unsignedMask = mask >>> 0;
  if (unsignedMask === 0) {
    throw corrupt("BMP color masks must be nonzero");
  }

  if (
    bitsPerPixel < 32 &&
    unsignedMask >= 2 ** bitsPerPixel
  ) {
    throw corrupt("BMP color mask uses bits outside the pixel");
  }

  let shift = 0;
  while (shift < 32 && ((unsignedMask >>> shift) & 1) === 0) {
    shift += 1;
  }

  let width = 0;
  while (
    shift + width < 32 &&
    ((unsignedMask >>> (shift + width)) & 1) === 1
  ) {
    width += 1;
  }

  if (width === 0 || shift + width < 32 && (unsignedMask >>> (shift + width)) !== 0) {
    throw corrupt("BMP color masks must contain one contiguous bit range");
  }

  return {
    mask: unsignedMask,
    shift,
    maximum: width === 32 ? 0xffff_ffff : 2 ** width - 1,
  };
}

function parseMasks(
  rawMasks: readonly [number, number, number, number],
  bitsPerPixel: number,
  alphaRequired: boolean,
): PixelMasks {
  const [rawRed, rawGreen, rawBlue, rawAlpha] = rawMasks;
  const combinedRgb = (rawRed | rawGreen | rawBlue) >>> 0;
  if (
    (rawRed & rawGreen) !== 0 ||
    (rawRed & rawBlue) !== 0 ||
    (rawGreen & rawBlue) !== 0
  ) {
    throw corrupt("BMP RGB masks overlap");
  }

  const alpha = rawAlpha === 0
    ? null
    : parseChannelMask(rawAlpha, bitsPerPixel);
  if (alphaRequired && alpha === null) {
    throw corrupt("BMP alpha-bitfields compression requires an alpha mask");
  }
  if (alpha !== null && (alpha.mask & combinedRgb) !== 0) {
    throw corrupt("BMP alpha mask overlaps a color mask");
  }

  return {
    red: parseChannelMask(rawRed, bitsPerPixel),
    green: parseChannelMask(rawGreen, bitsPerPixel),
    blue: parseChannelMask(rawBlue, bitsPerPixel),
    alpha,
  };
}

function normalizeChannel(value: number, channel: ChannelMask): number {
  const masked = ((value & channel.mask) >>> channel.shift) >>> 0;
  return Math.round(masked * 255 / channel.maximum);
}

function setPixel(
  output: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  red: number,
  green: number,
  blue: number,
  alpha = 255,
): void {
  const outputOffset = (y * width + x) * 4;
  output[outputOffset] = red;
  output[outputOffset + 1] = green;
  output[outputOffset + 2] = blue;
  output[outputOffset + 3] = alpha;
}

function palettePixel(
  output: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  index: number,
  palette: readonly PaletteEntry[],
): void {
  const entry = palette[index];
  if (entry === undefined) {
    throw corrupt("BMP pixel references a palette entry that is not present");
  }
  setPixel(output, width, x, y, entry[0], entry[1], entry[2]);
}

function decodeUncompressed(
  bytes: Uint8Array,
  fileEnd: number,
  pixelOffset: number,
  width: number,
  height: number,
  topDown: boolean,
  bitsPerPixel: number,
  palette: readonly PaletteEntry[],
  masks: PixelMasks | null,
  declaredImageSize: number,
): Uint8ClampedArray {
  const rowBits = checkedMultiply(width, bitsPerPixel, "BMP row size overflows");
  const stride = checkedMultiply(
    Math.floor(checkedAdd(rowBits, 31, "BMP row alignment overflows") / 32),
    4,
    "BMP row stride overflows",
  );
  const pixelBytes = checkedMultiply(stride, height, "BMP pixel array size overflows");
  const pixelEnd = checkedAdd(pixelOffset, pixelBytes, "BMP pixel array offset overflows");
  if (pixelEnd > fileEnd) {
    throw corrupt("BMP pixel rows are truncated");
  }
  if (declaredImageSize !== 0 && declaredImageSize !== pixelBytes) {
    throw corrupt("BMP uncompressed image size does not match its row stride");
  }

  const output = new Uint8ClampedArray(width * height * 4);
  for (let storedRow = 0; storedRow < height; storedRow += 1) {
    const y = topDown ? storedRow : height - 1 - storedRow;
    const rowOffset = pixelOffset + storedRow * stride;

    for (let x = 0; x < width; x += 1) {
      if (bitsPerPixel === 1) {
        const packed = bytes[rowOffset + (x >>> 3)]!;
        palettePixel(output, width, x, y, (packed >>> (7 - (x & 7))) & 1, palette);
      } else if (bitsPerPixel === 4) {
        const packed = bytes[rowOffset + (x >>> 1)]!;
        palettePixel(
          output,
          width,
          x,
          y,
          x % 2 === 0 ? packed >>> 4 : packed & 0x0f,
          palette,
        );
      } else if (bitsPerPixel === 8) {
        palettePixel(output, width, x, y, bytes[rowOffset + x]!, palette);
      } else if (bitsPerPixel === 16) {
        const offset = rowOffset + x * 2;
        const value = bytes[offset]! | bytes[offset + 1]! << 8;
        if (masks === null) {
          throw corrupt("BMP 16-bit pixels require color masks");
        }
        setPixel(
          output,
          width,
          x,
          y,
          normalizeChannel(value, masks.red),
          normalizeChannel(value, masks.green),
          normalizeChannel(value, masks.blue),
          masks.alpha === null ? 255 : normalizeChannel(value, masks.alpha),
        );
      } else if (bitsPerPixel === 24) {
        const offset = rowOffset + x * 3;
        setPixel(
          output,
          width,
          x,
          y,
          bytes[offset + 2]!,
          bytes[offset + 1]!,
          bytes[offset]!,
        );
      } else {
        const offset = rowOffset + x * 4;
        if (masks === null) {
          setPixel(
            output,
            width,
            x,
            y,
            bytes[offset + 2]!,
            bytes[offset + 1]!,
            bytes[offset]!,
          );
        } else {
          const value = (
            bytes[offset]! +
            bytes[offset + 1]! * 0x100 +
            bytes[offset + 2]! * 0x10000 +
            bytes[offset + 3]! * 0x1000000
          ) >>> 0;
          setPixel(
            output,
            width,
            x,
            y,
            normalizeChannel(value, masks.red),
            normalizeChannel(value, masks.green),
            normalizeChannel(value, masks.blue),
            masks.alpha === null ? 255 : normalizeChannel(value, masks.alpha),
          );
        }
      }
    }
  }
  return output;
}

function decodeRle(
  bytes: Uint8Array,
  fileEnd: number,
  pixelOffset: number,
  width: number,
  height: number,
  bitsPerPixel: 4 | 8,
  palette: readonly PaletteEntry[],
  declaredImageSize: number,
): Uint8ClampedArray {
  const streamEnd = declaredImageSize === 0
    ? fileEnd
    : checkedAdd(pixelOffset, declaredImageSize, "BMP RLE stream size overflows");
  if (streamEnd > fileEnd) {
    throw corrupt("BMP RLE stream is truncated");
  }

  const output = new Uint8ClampedArray(width * height * 4);
  const background = palette[0];
  if (background === undefined) {
    throw corrupt("BMP indexed image has no palette");
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      setPixel(output, width, x, y, background[0], background[1], background[2]);
    }
  }

  let cursor = pixelOffset;
  let x = 0;
  let y = height - 1;
  let foundEnd = false;
  let commands = 0;
  const commandBudget = width * height + height + 1;

  const requireStream = (length: number, message: string): void => {
    requireBytes(bytes, cursor, length, message, streamEnd);
  };
  const writeIndex = (index: number): void => {
    if (y < 0 || y >= height || x < 0 || x >= width) {
      throw corrupt("BMP RLE run moves outside the image");
    }
    palettePixel(output, width, x, y, index, palette);
    x += 1;
  };

  while (cursor < streamEnd) {
    commands += 1;
    if (commands > commandBudget) {
      throw corrupt("BMP RLE command budget was exceeded");
    }
    requireStream(2, "BMP RLE command is truncated");
    const count = bytes[cursor]!;
    const command = bytes[cursor + 1]!;
    cursor += 2;

    if (count !== 0) {
      if (y < 0 || x + count > width) {
        throw corrupt("BMP RLE encoded run crosses an image boundary");
      }
      for (let index = 0; index < count; index += 1) {
        writeIndex(
          bitsPerPixel === 8
            ? command
            : index % 2 === 0 ? command >>> 4 : command & 0x0f,
        );
      }
      continue;
    }

    if (command === 0) {
      if (y < 0) {
        throw corrupt("BMP RLE EOL moves outside the image");
      }
      x = 0;
      y -= 1;
      continue;
    }
    if (command === 1) {
      foundEnd = true;
      break;
    }
    if (command === 2) {
      requireStream(2, "BMP RLE delta is truncated");
      const deltaX = bytes[cursor]!;
      const deltaY = bytes[cursor + 1]!;
      cursor += 2;
      if (deltaX === 0 && deltaY === 0) {
        throw corrupt("BMP RLE delta command must make progress");
      }
      const nextX = x + deltaX;
      const nextY = y - deltaY;
      if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) {
        throw corrupt("BMP RLE delta moves outside the image");
      }
      x = nextX;
      y = nextY;
      continue;
    }

    const absolutePixels = command;
    if (y < 0 || x + absolutePixels > width) {
      throw corrupt("BMP RLE absolute run crosses an image boundary");
    }
    const packedBytes = bitsPerPixel === 8
      ? absolutePixels
      : Math.ceil(absolutePixels / 2);
    const paddedBytes = packedBytes + (packedBytes & 1);
    requireStream(paddedBytes, "BMP RLE absolute run or pad byte is truncated");
    for (let index = 0; index < absolutePixels; index += 1) {
      const packed = bytes[cursor + (bitsPerPixel === 8 ? index : index >>> 1)]!;
      writeIndex(
        bitsPerPixel === 8
          ? packed
          : index % 2 === 0 ? packed >>> 4 : packed & 0x0f,
      );
    }
    cursor += paddedBytes;
  }

  if (!foundEnd) {
    throw corrupt("BMP RLE stream is missing its end-of-bitmap command");
  }
  return output;
}

export function decodeBmp(bytes: Uint8Array): RgbaImage {
  requireBytes(bytes, 0, FILE_HEADER_BYTES + 4, "BMP header is truncated");
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
    throw corrupt("BMP does not begin with the BM file signature");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredFileSize = readU32(view, 2);
  const fileEnd = declaredFileSize === 0 ? bytes.length : declaredFileSize;
  if (fileEnd !== bytes.length) {
    throw corrupt("BMP declared file size does not match the available bytes");
  }

  const pixelOffset = readU32(view, 10);
  const dibSize = readU32(view, 14);
  if (dibSize !== CORE_HEADER_BYTES && !WINDOWS_DIB_SIZES.has(dibSize)) {
    if (dibSize < 40) {
      throw unsupported(`BMP DIB header size ${dibSize} is not supported`);
    }
    throw unsupported(`BMP Windows DIB header size ${dibSize} is unknown`);
  }
  requireBytes(bytes, FILE_HEADER_BYTES, dibSize, "BMP DIB header is truncated", fileEnd);

  const isCore = dibSize === CORE_HEADER_BYTES;
  const width = isCore ? readU16(view, 18) : readI32(view, 18);
  const signedHeight = isCore ? readU16(view, 20) : readI32(view, 22);
  const planes = isCore ? readU16(view, 22) : readU16(view, 26);
  const bitsPerPixel = isCore ? readU16(view, 24) : readU16(view, 28);
  const compression = isCore ? BI_RGB : readU32(view, 30);
  const declaredImageSize = isCore ? 0 : readU32(view, 34);
  const colorsUsed = isCore ? 0 : readU32(view, 46);

  if (width <= 0 || signedHeight === 0 || signedHeight === -0x8000_0000) {
    throw corrupt("BMP dimensions must have positive width and nonzero safe height");
  }
  if (planes !== 1) {
    throw corrupt("BMP must contain exactly one color plane");
  }
  if (![1, 4, 8, 16, 24, 32].includes(bitsPerPixel)) {
    throw unsupported(`BMP bit depth ${bitsPerPixel} is not supported`);
  }
  if (isCore && ![1, 4, 8, 24].includes(bitsPerPixel)) {
    throw unsupported(
      `BMP COREHEADER bit depth ${bitsPerPixel} is not supported`,
    );
  }
  if (![BI_RGB, BI_RLE8, BI_RLE4, BI_BITFIELDS, BI_ALPHABITFIELDS].includes(compression)) {
    throw unsupported(`BMP compression ${compression} is not supported`);
  }

  const height = Math.abs(signedHeight);
  const topDown = !isCore && signedHeight < 0;
  const pixelCount = checkedMultiply(width, height, "BMP dimensions overflow");
  if (pixelCount > MAX_DECODED_PIXELS) {
    throw new ProcessingError(
      "LIMIT_EXCEEDED",
      `BMP exceeds the ${MAX_DECODED_PIXELS.toLocaleString()}-pixel decode limit`,
    );
  }

  if (
    (compression === BI_RLE8 && bitsPerPixel !== 8) ||
    (compression === BI_RLE4 && bitsPerPixel !== 4) ||
    ((compression === BI_BITFIELDS || compression === BI_ALPHABITFIELDS) &&
      bitsPerPixel !== 16 && bitsPerPixel !== 32)
  ) {
    throw corrupt("BMP compression and bit depth are inconsistent");
  }
  if (topDown && (compression === BI_RLE4 || compression === BI_RLE8)) {
    throw unsupported("Top-down BMP images cannot use RLE compression");
  }

  if (dibSize >= 108) {
    const colorSpaceType = readU32(view, 70);
    if (
      colorSpaceType !== LCS_SRGB &&
      colorSpaceType !== LCS_WINDOWS_COLOR_SPACE
    ) {
      throw unsupported(
        "BMP V4/V5 color space is not explicitly compatible with sRGB",
      );
    }
    if (
      dibSize >= 124 &&
      (readU32(view, 126) !== 0 || readU32(view, 130) !== 0)
    ) {
      throw unsupported(
        "BMP V5 embedded or linked color profiles are not supported",
      );
    }
  }

  let metadataEnd = FILE_HEADER_BYTES + dibSize;
  let masks: PixelMasks | null = null;
  if (bitsPerPixel === 16 && compression === BI_RGB) {
    masks = parseMasks([0x7c00, 0x03e0, 0x001f, 0], bitsPerPixel, false);
  }

  if (compression === BI_BITFIELDS || compression === BI_ALPHABITFIELDS) {
    let rawMasks: [number, number, number, number];
    if (dibSize === 40) {
      const count = compression === BI_ALPHABITFIELDS ? 4 : 3;
      requireBytes(bytes, metadataEnd, count * 4, "BMP external color masks are truncated", fileEnd);
      rawMasks = [
        readU32(view, metadataEnd),
        readU32(view, metadataEnd + 4),
        readU32(view, metadataEnd + 8),
        count === 4 ? readU32(view, metadataEnd + 12) : 0,
      ];
      metadataEnd += count * 4;
    } else {
      if (dibSize < 52 || compression === BI_ALPHABITFIELDS && dibSize < 56) {
        throw corrupt("BMP DIB header does not contain the required color masks");
      }
      rawMasks = [
        readU32(view, 54),
        readU32(view, 58),
        readU32(view, 62),
        dibSize >= 56 ? readU32(view, 66) : 0,
      ];
    }
    masks = parseMasks(rawMasks, bitsPerPixel, compression === BI_ALPHABITFIELDS);
  } else if (
    compression === BI_RGB &&
    (bitsPerPixel === 16 || bitsPerPixel === 32) &&
    dibSize >= 56
  ) {
    const rawMasks = [
      readU32(view, 54),
      readU32(view, 58),
      readU32(view, 62),
      readU32(view, 66),
    ] as const;
    const anyMask = rawMasks.some((mask) => mask !== 0);
    if (anyMask) {
      masks = parseMasks(rawMasks, bitsPerPixel, false);
    }
  }

  const palette: PaletteEntry[] = [];
  if (bitsPerPixel <= 8) {
    const maximumEntries = 2 ** bitsPerPixel;
    const paletteEntries = isCore
      ? maximumEntries
      : colorsUsed === 0 ? maximumEntries : colorsUsed;
    if (paletteEntries > maximumEntries) {
      throw corrupt("BMP palette declares too many entries for its bit depth");
    }
    const entryBytes = isCore ? 3 : 4;
    const paletteBytes = checkedMultiply(
      paletteEntries,
      entryBytes,
      "BMP palette size overflows",
    );
    const paletteEnd = checkedAdd(metadataEnd, paletteBytes, "BMP palette offset overflows");
    if (paletteEnd > pixelOffset || paletteEnd > fileEnd) {
      throw corrupt("BMP palette is truncated or overlaps the pixel array");
    }
    for (let index = 0; index < paletteEntries; index += 1) {
      const offset = metadataEnd + index * entryBytes;
      palette.push([bytes[offset + 2]!, bytes[offset + 1]!, bytes[offset]!]);
    }
    metadataEnd = paletteEnd;
  }

  if (pixelOffset < metadataEnd || pixelOffset >= fileEnd) {
    throw corrupt("BMP pixel offset is outside the file or overlaps metadata");
  }

  const data = compression === BI_RLE4 || compression === BI_RLE8
    ? decodeRle(
      bytes,
      fileEnd,
      pixelOffset,
      width,
      height,
      compression === BI_RLE4 ? 4 : 8,
      palette,
      declaredImageSize,
    )
    : decodeUncompressed(
      bytes,
      fileEnd,
      pixelOffset,
      width,
      height,
      topDown,
      bitsPerPixel,
      palette,
      masks,
      declaredImageSize,
    );

  return { data, width, height };
}
