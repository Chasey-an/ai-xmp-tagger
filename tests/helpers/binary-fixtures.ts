const textEncoder = new TextEncoder();
const pngSignature = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const knownValidJpeg1x1Base64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAYGBgYHBgcICAcKCwoLCg8ODAwODxYQERAREBYiFRkVFRkVIh4kHhweJB42KiYmKjY+NDI0PkxERExfWl98fKcBBgYGBgcGBwgIBwoLCgsKDw4MDA4PFhAREBEQFiIVGRUVGRUiHiQeHB4kHjYqJiYqNj40MjQ+TERETF9aX3x8p//CABEIAAEAAQMBIQACEQEDEQH/xAAnAAEBAAAAAAAAAAAAAAAAAAAACAEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEAMQAAAAqkf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/AH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AH//2Q==";
const knownValidPng1x1Base64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const knownValidWebp1x1Base64 =
  "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";

export function concatBytes(
  ...parts: ReadonlyArray<Uint8Array | readonly number[]>
): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

export function utf8Bytes(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function knownValidJpeg1x1(): Uint8Array {
  const binary = atob(knownValidJpeg1x1Base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function knownValidPng1x1(): Uint8Array {
  const binary = atob(knownValidPng1x1Base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function knownValidWebp1x1(): Uint8Array {
  const binary = atob(knownValidWebp1x1Base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function jpegSegment(
  marker: number,
  payload: Uint8Array | readonly number[] = [],
): Uint8Array {
  const length = payload.length + 2;
  if (marker < 0 || marker > 0xff || length > 0xffff) {
    throw new RangeError("Invalid JPEG fixture segment");
  }

  return concatBytes(
    [0xff, marker, length >>> 8, length & 0xff],
    payload,
  );
}

export function jpegStandalone(marker: number): Uint8Array {
  if (marker < 0 || marker > 0xff) {
    throw new RangeError("Invalid JPEG fixture marker");
  }

  return new Uint8Array([0xff, marker]);
}

export function minimalJpeg(
  segments: readonly Uint8Array[] = [],
  entropy: Uint8Array | readonly number[] = [0x01, 0x02, 0x03],
): Uint8Array {
  const sos = jpegSegment(0xda, [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  return concatBytes([0xff, 0xd8], ...segments, sos, entropy, [0xff, 0xd9]);
}

function fixtureCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

export function pngChunk(
  type: string,
  data: Uint8Array | readonly number[] = [],
): Uint8Array {
  const typeBytes = textEncoder.encode(type);
  if (typeBytes.length !== 4 || data.length > 0xffffffff) {
    throw new RangeError("Invalid PNG fixture chunk");
  }

  const body = concatBytes(typeBytes, data);
  const crc = fixtureCrc32(body);
  return concatBytes(
    [
      data.length >>> 24,
      (data.length >>> 16) & 0xff,
      (data.length >>> 8) & 0xff,
      data.length & 0xff,
    ],
    body,
    [crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff],
  );
}

export function minimalPng(
  chunks: readonly Uint8Array[] = [],
): Uint8Array {
  const ihdr = pngChunk("IHDR", [
    0x00, 0x00, 0x00, 0x01,
    0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00,
  ]);
  return concatBytes(pngSignature, ihdr, ...chunks, pngChunk("IEND"));
}

export function webpChunk(
  fourcc: string,
  data: Uint8Array | readonly number[] = [],
  pad = 0,
): Uint8Array {
  const fourccBytes = textEncoder.encode(fourcc);
  if (
    fourccBytes.length !== 4 ||
    data.length > 0xffffffff ||
    pad < 0 ||
    pad > 0xff
  ) {
    throw new RangeError("Invalid WebP fixture chunk");
  }

  return concatBytes(
    fourccBytes,
    [
      data.length & 0xff,
      (data.length >>> 8) & 0xff,
      (data.length >>> 16) & 0xff,
      data.length >>> 24,
    ],
    data,
    data.length % 2 === 1 ? [pad] : [],
  );
}

export function minimalWebp(
  chunks: readonly Uint8Array[] = [],
): Uint8Array {
  const body = concatBytes(utf8Bytes("WEBP"), ...chunks);
  return concatBytes(
    utf8Bytes("RIFF"),
    [
      body.length & 0xff,
      (body.length >>> 8) & 0xff,
      (body.length >>> 16) & 0xff,
      body.length >>> 24,
    ],
    body,
  );
}
