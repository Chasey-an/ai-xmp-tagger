export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

function matchesExifIdentifier(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 6 &&
    bytes[0] === 0x45 &&
    bytes[1] === 0x78 &&
    bytes[2] === 0x69 &&
    bytes[3] === 0x66 &&
    bytes[4] === 0 &&
    bytes[5] === 0
  );
}

export function readExifOrientation(bytes: Uint8Array): ExifOrientation {
  const tiffOffset = matchesExifIdentifier(bytes) ? 6 : 0;
  if (bytes.length - tiffOffset < 8) {
    throw new RangeError("EXIF TIFF header is truncated");
  }

  const littleEndian =
    bytes[tiffOffset] === 0x49 && bytes[tiffOffset + 1] === 0x49;
  const bigEndian =
    bytes[tiffOffset] === 0x4d && bytes[tiffOffset + 1] === 0x4d;
  if (!littleEndian && !bigEndian) {
    throw new RangeError("EXIF TIFF byte order is invalid");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readU16 = (offset: number): number => {
    if (offset < 0 || offset + 2 > bytes.length) {
      throw new RangeError("EXIF uint16 field is truncated");
    }
    return view.getUint16(offset, littleEndian);
  };
  const readU32 = (offset: number): number => {
    if (offset < 0 || offset + 4 > bytes.length) {
      throw new RangeError("EXIF uint32 field is truncated");
    }
    return view.getUint32(offset, littleEndian);
  };

  if (readU16(tiffOffset + 2) !== 42) {
    throw new RangeError("EXIF TIFF marker is invalid");
  }
  const relativeIfdOffset = readU32(tiffOffset + 4);
  const ifdOffset = tiffOffset + relativeIfdOffset;
  if (
    !Number.isSafeInteger(ifdOffset) ||
    ifdOffset < tiffOffset + 8 ||
    ifdOffset + 2 > bytes.length
  ) {
    throw new RangeError("EXIF IFD0 offset is invalid");
  }

  const entryCount = readU16(ifdOffset);
  const entriesStart = ifdOffset + 2;
  const entriesBytes = entryCount * 12;
  if (
    !Number.isSafeInteger(entriesBytes) ||
    entriesStart + entriesBytes > bytes.length
  ) {
    throw new RangeError("EXIF IFD0 entries are truncated");
  }

  for (let index = 0; index < entryCount; index += 1) {
    const entry = entriesStart + index * 12;
    if (readU16(entry) !== 0x0112) continue;
    if (readU16(entry + 2) !== 3 || readU32(entry + 4) !== 1) {
      throw new RangeError("EXIF orientation field has an invalid type");
    }
    const orientation = readU16(entry + 8);
    if (orientation < 1 || orientation > 8) {
      throw new RangeError("EXIF orientation value is outside 1 through 8");
    }
    return orientation as ExifOrientation;
  }

  return 1;
}

export function orientationSwapsDimensions(
  orientation: ExifOrientation,
): boolean {
  return orientation >= 5;
}
