import { ProcessingError } from "../errors";

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const TEM = 0x01;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});
const standardXmpSignature = textEncoder.encode(
  "http://ns.adobe.com/xap/1.0/\0",
);
const extendedXmpSignature = textEncoder.encode(
  "http://ns.adobe.com/xmp/extension/\0",
);
const jfifSignature = textEncoder.encode("JFIF\0");
const jfxxSignature = textEncoder.encode("JFXX\0");
const exifSignature = textEncoder.encode("Exif\0\0");
const iccSignature = textEncoder.encode("ICC_PROFILE\0");

interface SegmentBounds {
  markerStart: number;
  end: number;
  payloadStart: number;
}

interface ParsedJpeg {
  scanStart: number;
  initialMetadataEnd: number;
  standardXmp: SegmentBounds | null;
}

function corruptContainer(message: string): ProcessingError {
  return new ProcessingError("CORRUPT_CONTAINER", message);
}

function invalidXmp(message: string, cause?: unknown): ProcessingError {
  return cause === undefined
    ? new ProcessingError("INVALID_XMP", message)
    : new ProcessingError("INVALID_XMP", message, { cause });
}

function startsWithAt(
  bytes: Uint8Array,
  prefix: Uint8Array,
  offset: number,
  end = bytes.length,
): boolean {
  if (offset + prefix.length > end) {
    return false;
  }

  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[offset + index] !== prefix[index]) {
      return false;
    }
  }

  return true;
}

function isRestartMarker(marker: number): boolean {
  return marker >= 0xd0 && marker <= 0xd7;
}

function isStandaloneMarker(marker: number): boolean {
  return marker === SOI || marker === TEM || isRestartMarker(marker);
}

function containsAt(
  bytes: Uint8Array,
  needle: Uint8Array,
  start: number,
  end: number,
): boolean {
  for (let offset = start; offset <= end - needle.length; offset += 1) {
    if (startsWithAt(bytes, needle, offset, end)) {
      return true;
    }
  }

  return false;
}

function parseJpeg(bytes: Uint8Array): ParsedJpeg {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== SOI) {
    throw corruptContainer("JPEG does not begin with an SOI marker");
  }

  let initialMetadataEnd = 2;
  let acceptingInitialMetadata = true;
  let standardXmp: SegmentBounds | null = null;
  let hasDuplicateStandardXmp = false;
  let hasExtendedXmp = false;
  let offset = 2;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      throw corruptContainer("JPEG marker stream contains non-marker data");
    }

    let markerCodeOffset = offset + 1;
    while (
      markerCodeOffset < bytes.length &&
      bytes[markerCodeOffset] === 0xff
    ) {
      markerCodeOffset += 1;
    }

    if (markerCodeOffset >= bytes.length) {
      throw corruptContainer("JPEG marker is truncated");
    }

    const marker = bytes[markerCodeOffset]!;
    const markerStart = markerCodeOffset - 1;

    if (marker === 0x00) {
      throw corruptContainer("JPEG contains byte stuffing before SOS");
    }
    if (marker === EOI) {
      throw corruptContainer("JPEG ends before an SOS marker");
    }

    if (isStandaloneMarker(marker)) {
      acceptingInitialMetadata = false;
      offset = markerCodeOffset + 1;
      continue;
    }

    if (markerCodeOffset + 2 >= bytes.length) {
      throw corruptContainer("JPEG segment length is truncated");
    }

    const length =
      (bytes[markerCodeOffset + 1]! << 8) | bytes[markerCodeOffset + 2]!;
    if (length < 2) {
      throw corruptContainer("JPEG segment length is smaller than two");
    }

    const payloadStart = markerCodeOffset + 3;
    const segmentEnd = markerCodeOffset + 1 + length;
    if (segmentEnd > bytes.length) {
      throw corruptContainer("JPEG segment extends beyond the file");
    }

    if (marker === SOS) {
      if (hasExtendedXmp) {
        throw new ProcessingError(
          "EXTENDED_XMP_UNSUPPORTED",
          "Extended XMP is not supported",
        );
      }
      if (hasDuplicateStandardXmp) {
        throw new ProcessingError(
          "XMP_CONFLICT",
          "JPEG contains more than one standard XMP packet",
        );
      }

      return {
        scanStart: markerStart,
        initialMetadataEnd,
        standardXmp,
      };
    }

    if (
      containsAt(
        bytes,
        extendedXmpSignature,
        payloadStart,
        segmentEnd,
      )
    ) {
      hasExtendedXmp = true;
    } else if (
      marker === APP1 &&
      startsWithAt(bytes, standardXmpSignature, payloadStart, segmentEnd)
    ) {
      if (standardXmp === null) {
        standardXmp = { markerStart, end: segmentEnd, payloadStart };
      } else {
        hasDuplicateStandardXmp = true;
      }
    }

    if (
      acceptingInitialMetadata &&
      isInitialMetadata(bytes, marker, payloadStart, segmentEnd)
    ) {
      initialMetadataEnd = segmentEnd;
    } else {
      acceptingInitialMetadata = false;
    }

    offset = segmentEnd;
  }

  throw corruptContainer("JPEG does not contain an SOS marker");
}

function decodePacket(bytes: Uint8Array, segment: SegmentBounds): string {
  const packetStart = segment.payloadStart + standardXmpSignature.length;

  try {
    return textDecoder.decode(bytes.subarray(packetStart, segment.end));
  } catch (error) {
    throw invalidXmp("JPEG XMP packet is not valid UTF-8", error);
  }
}

function assertValidUnicode(packet: string): void {
  for (let index = 0; index < packet.length; index += 1) {
    const code = packet.charCodeAt(index);

    if (code >= 0xd800 && code <= 0xdbff) {
      const following = packet.charCodeAt(index + 1);
      if (following < 0xdc00 || following > 0xdfff) {
        throw invalidXmp("XMP packet contains an unpaired UTF-16 surrogate");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw invalidXmp("XMP packet contains an unpaired UTF-16 surrogate");
    }
  }
}

function encodeXmpSegment(packet: string): Uint8Array {
  assertValidUnicode(packet);
  const packetBytes = textEncoder.encode(packet);
  const payloadLength = standardXmpSignature.length + packetBytes.length;
  const segmentLength = payloadLength + 2;

  if (segmentLength > 0xffff) {
    throw invalidXmp("XMP packet is too large for a JPEG APP1 segment");
  }

  const segment = new Uint8Array(payloadLength + 4);
  segment[0] = 0xff;
  segment[1] = APP1;
  segment[2] = segmentLength >>> 8;
  segment[3] = segmentLength & 0xff;
  segment.set(standardXmpSignature, 4);
  segment.set(packetBytes, 4 + standardXmpSignature.length);
  return segment;
}

function isInitialMetadata(
  bytes: Uint8Array,
  marker: number,
  payloadStart: number,
  end: number,
): boolean {
  if (marker === APP0) {
    return (
      startsWithAt(bytes, jfifSignature, payloadStart, end) ||
      startsWithAt(bytes, jfxxSignature, payloadStart, end)
    );
  }

  if (marker === APP1) {
    return startsWithAt(bytes, exifSignature, payloadStart, end);
  }

  return (
    marker === APP2 &&
    startsWithAt(bytes, iccSignature, payloadStart, end)
  );
}

function replaceRange(
  bytes: Uint8Array,
  start: number,
  end: number,
  replacement: Uint8Array,
): Uint8Array {
  const output = new Uint8Array(bytes.length - (end - start) + replacement.length);
  output.set(bytes.subarray(0, start));
  output.set(replacement, start);
  output.set(bytes.subarray(end), start + replacement.length);
  return output;
}

export function readJpegXmp(bytes: Uint8Array): string | null {
  const parsed = parseJpeg(bytes);
  return parsed.standardXmp === null
    ? null
    : decodePacket(bytes, parsed.standardXmp);
}

export function writeJpegXmp(
  bytes: Uint8Array,
  packet: string,
): Uint8Array {
  const parsed = parseJpeg(bytes);

  if (parsed.standardXmp !== null) {
    decodePacket(bytes, parsed.standardXmp);
  }

  const xmpSegment = encodeXmpSegment(packet);

  if (parsed.standardXmp !== null) {
    return replaceRange(
      bytes,
      parsed.standardXmp.markerStart,
      parsed.standardXmp.end,
      xmpSegment,
    );
  }

  return replaceRange(
    bytes,
    parsed.initialMetadataEnd,
    parsed.initialMetadataEnd,
    xmpSegment,
  );
}

export function extractJpegScan(bytes: Uint8Array): Uint8Array {
  return bytes.slice(parseJpeg(bytes).scanStart);
}
