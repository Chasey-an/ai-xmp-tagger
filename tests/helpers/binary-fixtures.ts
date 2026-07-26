const textEncoder = new TextEncoder();
const knownValidJpeg1x1Base64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAYGBgYHBgcICAcKCwoLCg8ODAwODxYQERAREBYiFRkVFRkVIh4kHhweJB42KiYmKjY+NDI0PkxERExfWl98fKcBBgYGBgcGBwgIBwoLCgsKDw4MDA4PFhAREBEQFiIVGRUVGRUiHiQeHB4kHjYqJiYqNj40MjQ+TERETF9aX3x8p//CABEIAAEAAQMBIQACEQEDEQH/xAAnAAEBAAAAAAAAAAAAAAAAAAAACAEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEAMQAAAAqkf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/AH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AH//2Q==";

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
