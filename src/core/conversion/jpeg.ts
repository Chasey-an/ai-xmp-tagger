import encode, { init } from "@jsquash/jpeg/encode.js";

import { getSrgb2014Profile } from "../../assets/srgb2014";
import { MAX_DECODED_PIXELS } from "../constants";
import { ProcessingError } from "../errors";
import type { RgbaImage } from "./bmp";

export type { RgbaImage } from "./bmp";

const APP0 = 0xe0;
const APP2 = 0xe2;
const APP15 = 0xef;
const COM = 0xfe;
const SOF0 = 0xc0;
const SOF2 = 0xc2;
const SOS = 0xda;
const JFIF_IDENTIFIER = new Uint8Array([0x4a, 0x46, 0x49, 0x46, 0]);
const ICC_IDENTIFIER = new Uint8Array([
  0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0,
]);
const MAX_JPEG_DIMENSION = 0xffff;
const MAX_SEGMENT_PAYLOAD = 0xffff - 2;
const ICC_OVERHEAD = ICC_IDENTIFIER.length + 2;
const MAX_ICC_CHUNK_BYTES = MAX_SEGMENT_PAYLOAD - ICC_OVERHEAD;
const HIGH_QUALITY_OPTIONS = {
  quality: 100,
  baseline: true,
  progressive: false,
  auto_subsample: false,
  chroma_subsample: 1,
  separate_chroma_quality: true,
  chroma_quality: 100,
} as const;

let encoderReadiness: Promise<void> | null = null;

export function prepareHighQualityJpegEncoder(): Promise<void> {
  if (encoderReadiness !== null) {
    return encoderReadiness;
  }

  const attempt = (async () => {
    await init();
    await encode(
      {
        width: 1,
        height: 1,
        data: new Uint8ClampedArray([255, 255, 255, 255]),
      } as ImageData,
      HIGH_QUALITY_OPTIONS,
    );
  })();
  const guarded = attempt.catch((error: unknown) => {
    if (encoderReadiness === guarded) {
      encoderReadiness = null;
    }
    throw new ProcessingError(
      "ENCODE_FAILED",
      "JPEG 编码器初始化失败，请重试。",
      { cause: error },
    );
  });
  encoderReadiness = guarded;
  return guarded;
}

interface JpegSegment {
  start: number;
  end: number;
  marker: number;
  payloadStart: number;
  payloadEnd: number;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function fail(message: string): never {
  throw new Error(message);
}

function scanHeader(jpeg: Uint8Array): JpegSegment[] {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    fail("JPEG encoder output has no SOI marker");
  }

  const segments: JpegSegment[] = [];
  let offset = 2;
  let foundSos = false;
  while (offset < jpeg.length) {
    const start = offset;
    if (jpeg[offset] !== 0xff) {
      fail("JPEG header contains data outside a marker segment");
    }
    while (offset < jpeg.length && jpeg[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= jpeg.length) fail("JPEG marker is truncated");
    const marker = jpeg[offset]!;
    offset += 1;

    if (marker === 0 || marker === 0xd8 || marker === 0xd9) {
      fail("JPEG header contains an invalid standalone marker");
    }
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) {
      segments.push({
        start,
        end: offset,
        marker,
        payloadStart: offset,
        payloadEnd: offset,
      });
      continue;
    }
    if (offset + 2 > jpeg.length) fail("JPEG segment length is truncated");
    const length = jpeg[offset]! * 0x100 + jpeg[offset + 1]!;
    if (length < 2) fail("JPEG segment has an invalid length");
    const end = offset + length;
    if (end > jpeg.length) fail("JPEG segment extends beyond the file");
    segments.push({
      start,
      end,
      marker,
      payloadStart: offset + 2,
      payloadEnd: end,
    });
    offset = end;
    if (marker === SOS) {
      foundSos = true;
      break;
    }
  }
  if (!foundSos) fail("JPEG encoder output has no start-of-scan marker");
  return segments;
}

function isIccSegment(jpeg: Uint8Array, segment: JpegSegment): boolean {
  if (
    segment.marker !== APP2 ||
    segment.payloadEnd - segment.payloadStart < ICC_OVERHEAD
  ) {
    return false;
  }
  return sameBytes(
    jpeg.subarray(
      segment.payloadStart,
      segment.payloadStart + ICC_IDENTIFIER.length,
    ),
    ICC_IDENTIFIER,
  );
}

function isApprovedJfif(
  jpeg: Uint8Array,
  segment: JpegSegment,
): boolean {
  if (
    segment.marker !== APP0 ||
    segment.payloadEnd - segment.payloadStart < 14 ||
    !sameBytes(
      jpeg.subarray(
        segment.payloadStart,
        segment.payloadStart + JFIF_IDENTIFIER.length,
      ),
      JFIF_IDENTIFIER,
    )
  ) {
    return false;
  }
  const thumbnailWidth = jpeg[segment.payloadStart + 12]!;
  const thumbnailHeight = jpeg[segment.payloadStart + 13]!;
  const expectedLength = 14 + thumbnailWidth * thumbnailHeight * 3;
  return segment.payloadEnd - segment.payloadStart === expectedLength;
}

function isStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function validateSingleScanTail(
  jpeg: Uint8Array,
  scanDataStart: number,
): void {
  let offset = scanDataStart;
  while (offset < jpeg.length) {
    if (jpeg[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    let markerOffset = offset + 1;
    while (
      markerOffset < jpeg.length &&
      jpeg[markerOffset] === 0xff
    ) {
      markerOffset += 1;
    }
    if (markerOffset >= jpeg.length) {
      fail("JPEG encoder scan ends with a truncated marker");
    }

    const marker = jpeg[markerOffset]!;
    if (
      marker === 0x00 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset = markerOffset + 1;
      continue;
    }
    if (marker === 0xd9 && markerOffset === jpeg.length - 1) {
      return;
    }
    fail("JPEG encoder output contains metadata or another frame after SOS");
  }
  fail("JPEG encoder output has no EOI marker after its scan");
}

function createIccSegments(profile: Uint8Array): Uint8Array[] {
  const total = Math.ceil(profile.length / MAX_ICC_CHUNK_BYTES);
  if (total < 1 || total > 255) {
    fail("ICC profile requires too many JPEG APP2 segments");
  }

  const segments: Uint8Array[] = [];
  for (let index = 0; index < total; index += 1) {
    const chunk = profile.subarray(
      index * MAX_ICC_CHUNK_BYTES,
      Math.min(profile.length, (index + 1) * MAX_ICC_CHUNK_BYTES),
    );
    const payloadLength = ICC_OVERHEAD + chunk.length;
    const length = payloadLength + 2;
    const segment = new Uint8Array(payloadLength + 4);
    segment.set([0xff, APP2, length >>> 8, length & 0xff]);
    segment.set(ICC_IDENTIFIER, 4);
    segment[4 + ICC_IDENTIFIER.length] = index + 1;
    segment[5 + ICC_IDENTIFIER.length] = total;
    segment.set(chunk, 4 + ICC_OVERHEAD);
    segments.push(segment);
  }
  return segments;
}

function embedIcc(jpeg: Uint8Array, profile: Uint8Array): Uint8Array {
  const segments = scanHeader(jpeg);
  const iccSegments = createIccSegments(profile);
  const output: Uint8Array[] = [jpeg.subarray(0, 2)];
  let inserted = false;

  for (const segment of segments) {
    if (!inserted && segment.marker !== APP0) {
      output.push(...iccSegments);
      inserted = true;
    }
    if (!isIccSegment(jpeg, segment)) {
      output.push(jpeg.subarray(segment.start, segment.end));
    }
    if (segment.marker === SOS) {
      output.push(jpeg.subarray(segment.end));
      break;
    }
  }
  if (!inserted) fail("JPEG ICC profile could not be inserted");
  return concatBytes(output);
}

function validateOutput(
  jpeg: Uint8Array,
  width: number,
  height: number,
  profile: Uint8Array,
): void {
  if (
    jpeg.length < 4 ||
    jpeg[jpeg.length - 2] !== 0xff ||
    jpeg[jpeg.length - 1] !== 0xd9
  ) {
    fail("JPEG encoder output has no final EOI marker");
  }

  const segments = scanHeader(jpeg);
  let foundSof0 = false;
  const iccChunks = new Map<number, Uint8Array>();
  let iccTotal = 0;

  for (const segment of segments) {
    if (segment.marker === SOF2) {
      fail("JPEG encoder produced a progressive SOF2 frame");
    }
    if (segment.marker === SOF0) {
      if (foundSof0) fail("JPEG encoder output has multiple SOF0 frames");
      const payload = jpeg.subarray(segment.payloadStart, segment.payloadEnd);
      if (payload.length < 15 || payload[5] !== 3 || payload.length !== 15) {
        fail("JPEG SOF0 frame does not contain exactly three components");
      }
      const actualHeight = payload[1]! * 0x100 + payload[2]!;
      const actualWidth = payload[3]! * 0x100 + payload[4]!;
      if (actualWidth !== width || actualHeight !== height) {
        fail("JPEG SOF0 dimensions differ from the source image");
      }
      for (let component = 0; component < 3; component += 1) {
        if (payload[7 + component * 3] !== 0x11) {
          fail("JPEG encoder output is not 4:4:4 sampled");
        }
      }
      foundSof0 = true;
    }

    if (isIccSegment(jpeg, segment)) {
      const sequenceOffset = segment.payloadStart + ICC_IDENTIFIER.length;
      const sequence = jpeg[sequenceOffset]!;
      const total = jpeg[sequenceOffset + 1]!;
      if (sequence === 0 || total === 0 || sequence > total) {
        fail("JPEG ICC APP2 sequence metadata is invalid");
      }
      if (iccTotal !== 0 && total !== iccTotal) {
        fail("JPEG ICC APP2 segments disagree on their total count");
      }
      if (iccChunks.has(sequence)) {
        fail("JPEG ICC APP2 sequence contains a duplicate segment");
      }
      iccTotal = total;
      iccChunks.set(sequence, jpeg.slice(sequenceOffset + 2, segment.payloadEnd));
    }
  }

  if (!foundSof0) fail("JPEG encoder output has no baseline SOF0 frame");
  if (iccTotal === 0 || iccChunks.size !== iccTotal) {
    fail("JPEG ICC APP2 sequence is incomplete");
  }
  const reassembled: Uint8Array[] = [];
  for (let sequence = 1; sequence <= iccTotal; sequence += 1) {
    const chunk = iccChunks.get(sequence);
    if (chunk === undefined) fail("JPEG ICC APP2 sequence is out of order");
    reassembled.push(chunk);
  }
  if (!sameBytes(concatBytes(reassembled), profile)) {
    fail("JPEG embedded ICC profile differs from the official profile");
  }
}

function validateInput(image: RgbaImage): void {
  if (
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width <= 0 ||
    image.height <= 0
  ) {
    fail("JPEG source dimensions are invalid");
  }
  const pixels = image.width * image.height;
  if (!Number.isSafeInteger(pixels)) {
    fail("JPEG source dimensions overflow");
  }
  if (pixels > MAX_DECODED_PIXELS) {
    throw new ProcessingError(
      "LIMIT_EXCEEDED",
      `JPEG source exceeds the ${MAX_DECODED_PIXELS.toLocaleString()}-pixel limit`,
    );
  }
  if (
    image.width > MAX_JPEG_DIMENSION ||
    image.height > MAX_JPEG_DIMENSION
  ) {
    fail("JPEG source dimensions exceed the format limit");
  }
  if (image.data.length !== pixels * 4) {
    fail("JPEG source RGBA byte length does not match its dimensions");
  }
}

/**
 * Treats encoder bytes as untrusted and returns only the JPEG coding stream,
 * an approved JFIF marker, and the exact bundled sRGB ICC profile.
 */
export function sanitizeHighQualityJpeg(
  jpeg: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  try {
    const segments = scanHeader(jpeg);
    const scan = segments[segments.length - 1];
    if (scan === undefined || scan.marker !== SOS) {
      fail("JPEG encoder output has no final SOS header");
    }
    validateSingleScanTail(jpeg, scan.end);
    const output: Uint8Array[] = [jpeg.subarray(0, 2)];
    let jfifSeen = false;

    for (const segment of segments) {
      if (isStartOfFrame(segment.marker) && segment.marker !== SOF0) {
        fail("JPEG encoder output contains a non-baseline frame");
      }

      if (segment.marker === APP0) {
        if (isApprovedJfif(jpeg, segment)) {
          if (jfifSeen) {
            fail("JPEG encoder output contains duplicate JFIF metadata");
          }
          jfifSeen = true;
          output.push(jpeg.subarray(segment.start, segment.end));
        }
      } else if (isIccSegment(jpeg, segment)) {
        output.push(jpeg.subarray(segment.start, segment.end));
      } else if (
        (segment.marker >= APP0 && segment.marker <= APP15) ||
        segment.marker === COM
      ) {
        // All unapproved application metadata is intentionally discarded.
      } else {
        output.push(jpeg.subarray(segment.start, segment.end));
      }

      if (segment.marker === SOS) {
        output.push(jpeg.subarray(segment.end));
        break;
      }
    }

    const sanitized = concatBytes(output);
    validateOutput(
      sanitized,
      width,
      height,
      getSrgb2014Profile(),
    );
    return sanitized;
  } catch (error) {
    if (error instanceof ProcessingError && error.code === "ENCODE_FAILED") {
      throw error;
    }
    throw new ProcessingError(
      "ENCODE_FAILED",
      "JPEG 编码结果包含无效或不安全的元数据。",
      { cause: error },
    );
  }
}

export async function encodeHighQualityJpeg(
  image: RgbaImage,
): Promise<Uint8Array> {
  try {
    validateInput(image);
    await prepareHighQualityJpegEncoder();
    const encoded = await encode(
      image as ImageData,
      HIGH_QUALITY_OPTIONS,
    );
    const profile = getSrgb2014Profile();
    const output = embedIcc(new Uint8Array(encoded), profile);
    validateOutput(output, image.width, image.height, profile);
    return output;
  } catch (error) {
    if (error instanceof ProcessingError && error.code === "LIMIT_EXCEEDED") {
      throw error;
    }
    if (error instanceof ProcessingError && error.code === "ENCODE_FAILED") {
      throw error;
    }
    throw new ProcessingError(
      "ENCODE_FAILED",
      "无法生成 JPEG，请重试或更换源图片。",
      { cause: error },
    );
  }
}
