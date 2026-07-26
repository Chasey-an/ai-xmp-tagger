import { MAX_XMP_BYTES } from "../constants";
import { ProcessingError } from "../errors";
import {
  readExifOrientation,
  type ExifOrientation,
} from "../exif-orientation";

export interface WebpChunk {
  fourcc: string;
  data: Uint8Array;
  raw: Uint8Array;
}

// At the 50 MiB product limit this still permits an average chunk size of
// roughly 3.2 KiB while preventing millions of tiny chunks from exhausting
// memory and CPU during parsing.
export const MAX_WEBP_CHUNKS = 16_384;

const RIFF_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const MAX_RIFF_SIZE = 0xffff_ffff;
const MAX_VP8X_CANVAS_PIXELS = 0xffff_ffff;
const VP8X_DATA_BYTES = 10;

const VP8X_XMP_FLAG = 0x04;
const VP8X_EXIF_FLAG = 0x08;
const VP8X_ALPHA_FLAG = 0x10;
const VP8X_ICC_FLAG = 0x20;
const VP8X_ANIMATION_FLAG = 0x02;
const DEFINED_WEBP_CHUNK_TYPES = new Set([
  "VP8X",
  "ICCP",
  "ANIM",
  "ANMF",
  "ALPH",
  "VP8 ",
  "VP8L",
  "EXIF",
  "XMP ",
]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", {
  fatal: true,
  // Preserve an initial U+FEFF instead of consuming it as a signature.
  ignoreBOM: true,
});

interface ParsedWebp {
  chunks: WebpChunk[];
  vp8x: WebpChunk | null;
  xmp: WebpChunk | null;
  parsedChunkCount: number;
}

interface ChunkParsingBudget {
  used: number;
}

interface SimpleImageFeatures {
  width: number;
  height: number;
  alpha: boolean;
}

interface CanvasDimensions {
  width: number;
  height: number;
}

export interface WebpInspection extends CanvasDimensions {
  animated: boolean;
  orientation: ExifOrientation;
}

function corruptContainer(message: string): ProcessingError {
  return new ProcessingError("CORRUPT_CONTAINER", message);
}

function invalidXmp(message: string, cause?: unknown): ProcessingError {
  return cause === undefined
    ? new ProcessingError("INVALID_XMP", message)
    : new ProcessingError("INVALID_XMP", message, { cause });
}

function chunkLimitExceeded(): ProcessingError {
  return new ProcessingError(
    "LIMIT_EXCEEDED",
    `WebP exceeds the ${MAX_WEBP_CHUNKS}-chunk processing limit`,
  );
}

function consumeChunkBudget(budget: ChunkParsingBudget): void {
  if (budget.used >= MAX_WEBP_CHUNKS) {
    throw chunkLimitExceeded();
  }
  budget.used += 1;
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! +
    bytes[offset + 1]! * 0x100 +
    bytes[offset + 2]! * 0x10000 +
    bytes[offset + 3]! * 0x1000000
  ) >>> 0;
}

function writeUint32Le(
  bytes: Uint8Array,
  offset: number,
  value: number,
): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = value >>> 24;
}

function readUint24Le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! +
    bytes[offset + 1]! * 0x100 +
    bytes[offset + 2]! * 0x10000
  );
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

function matchesAscii(
  bytes: Uint8Array,
  offset: number,
  expected: string,
): boolean {
  if (offset + expected.length > bytes.length) {
    return false;
  }

  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) {
      return false;
    }
  }

  return true;
}

function readFourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  );
}

function parseWebp(bytes: Uint8Array): ParsedWebp {
  if (
    bytes.length < RIFF_HEADER_BYTES ||
    !matchesAscii(bytes, 0, "RIFF")
  ) {
    throw corruptContainer("WebP does not begin with an exact RIFF header");
  }
  if (!matchesAscii(bytes, 8, "WEBP")) {
    throw corruptContainer("RIFF container type is not WEBP");
  }

  const declaredRiffSize = readUint32Le(bytes, 4);
  if (declaredRiffSize !== bytes.length - 8) {
    throw corruptContainer("WebP RIFF size does not match the file length");
  }

  const chunks: WebpChunk[] = [];
  let vp8x: WebpChunk | null = null;
  let xmp: WebpChunk | null = null;
  let offset = RIFF_HEADER_BYTES;
  const budget: ChunkParsingBudget = { used: 0 };

  while (offset < bytes.length) {
    const remaining = bytes.length - offset;
    if (remaining < CHUNK_HEADER_BYTES) {
      throw corruptContainer("WebP chunk header is truncated");
    }
    consumeChunkBudget(budget);

    const payloadLength = readUint32Le(bytes, offset + 4);
    const padLength = payloadLength & 1;
    const availablePayloadBytes =
      remaining - CHUNK_HEADER_BYTES - padLength;
    if (
      availablePayloadBytes < 0 ||
      payloadLength > availablePayloadBytes
    ) {
      throw corruptContainer(
        "WebP chunk data or required pad byte extends beyond the file",
      );
    }

    const dataStart = offset + CHUNK_HEADER_BYTES;
    const dataEnd = dataStart + payloadLength;
    const end = dataEnd + padLength;
    const chunk: WebpChunk = {
      fourcc: readFourcc(bytes, offset),
      data: bytes.subarray(dataStart, dataEnd),
      raw: bytes.subarray(offset, end),
    };

    if (chunk.fourcc === "VP8X") {
      if (vp8x !== null) {
        throw corruptContainer("WebP contains more than one VP8X chunk");
      }
      if (chunks.length !== 0) {
        throw corruptContainer("WebP VP8X chunk must be first");
      }
      if (chunk.data.length !== VP8X_DATA_BYTES) {
        throw corruptContainer("WebP VP8X chunk must contain exactly 10 bytes");
      }
      vp8x = chunk;
    } else if (chunk.fourcc === "XMP ") {
      if (xmp !== null) {
        throw new ProcessingError(
          "XMP_CONFLICT",
          "WebP contains more than one XMP chunk",
        );
      }
      xmp = chunk;
    }

    chunks.push(chunk);
    offset = end;
  }

  const parsed = {
    chunks,
    vp8x,
    xmp,
    parsedChunkCount: budget.used,
  };
  validateWebpStructure(parsed, budget);
  parsed.parsedChunkCount = budget.used;
  return parsed;
}

function decodeXmpChunk(chunk: WebpChunk): string {
  if (chunk.data.length > MAX_XMP_BYTES) {
    throw invalidXmp(
      `WebP XMP packet exceeds the ${MAX_XMP_BYTES}-byte limit`,
    );
  }

  try {
    return textDecoder.decode(chunk.data);
  } catch (error) {
    throw invalidXmp("WebP XMP packet is not valid UTF-8", error);
  }
}

function encodedUtf8Length(packet: string): number {
  let byteLength = 0;

  for (let index = 0; index < packet.length; index += 1) {
    const code = packet.charCodeAt(index);

    if (code <= 0x7f) {
      byteLength += 1;
    } else if (code <= 0x7ff) {
      byteLength += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const following = packet.charCodeAt(index + 1);
      if (following < 0xdc00 || following > 0xdfff) {
        throw invalidXmp("XMP packet contains an unpaired UTF-16 surrogate");
      }
      byteLength += 4;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw invalidXmp("XMP packet contains an unpaired UTF-16 surrogate");
    } else {
      byteLength += 3;
    }

    if (byteLength > MAX_XMP_BYTES) {
      throw invalidXmp(
        `XMP packet exceeds the ${MAX_XMP_BYTES}-byte limit`,
      );
    }
  }

  return byteLength;
}

function encodeXmpChunk(packet: string): Uint8Array {
  const payloadLength = encodedUtf8Length(packet);
  const packetBytes = new Uint8Array(payloadLength);
  const encoded = textEncoder.encodeInto(packet, packetBytes);
  if (
    encoded.read !== packet.length ||
    encoded.written !== payloadLength
  ) {
    throw invalidXmp("XMP packet could not be encoded as UTF-8");
  }

  return encodeChunk("XMP ", packetBytes);
}

function encodeChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const padLength = data.length & 1;
  const raw = new Uint8Array(CHUNK_HEADER_BYTES + data.length + padLength);
  for (let index = 0; index < 4; index += 1) {
    raw[index] = fourcc.charCodeAt(index);
  }
  writeUint32Le(raw, 4, data.length);
  raw.set(data, CHUNK_HEADER_BYTES);
  // Uint8Array initialization deliberately supplies a zero RIFF pad byte.
  return raw;
}

function parseVp8Dimensions(data: Uint8Array): SimpleImageFeatures {
  if (data.length < 10) {
    throw corruptContainer("WebP VP8 key-frame header is truncated");
  }
  if ((data[0]! & 0x01) !== 0) {
    throw corruptContainer("WebP VP8 image is not a key frame");
  }
  if (
    data[3] !== 0x9d ||
    data[4] !== 0x01 ||
    data[5] !== 0x2a
  ) {
    throw corruptContainer("WebP VP8 key-frame start code is invalid");
  }

  const width = (data[6]! | (data[7]! << 8)) & 0x3fff;
  const height = (data[8]! | (data[9]! << 8)) & 0x3fff;
  if (width === 0 || height === 0) {
    throw corruptContainer("WebP VP8 canvas dimensions must be nonzero");
  }

  return { width, height, alpha: false };
}

function parseVp8lDimensions(data: Uint8Array): SimpleImageFeatures {
  if (data.length < 5) {
    throw corruptContainer("WebP VP8L header is truncated");
  }
  if (data[0] !== 0x2f) {
    throw corruptContainer("WebP VP8L signature is invalid");
  }

  const packed = readUint32Le(data, 1);
  const version = packed >>> 29;
  if (version !== 0) {
    throw corruptContainer("WebP VP8L version is unsupported");
  }

  const width = (packed & 0x3fff) + 1;
  const height = ((packed >>> 14) & 0x3fff) + 1;
  if (
    width < 1 ||
    width > 16_384 ||
    height < 1 ||
    height > 16_384
  ) {
    throw corruptContainer("WebP VP8L canvas dimensions are invalid");
  }

  return {
    width,
    height,
    alpha: (packed & 0x1000_0000) !== 0,
  };
}

function simpleImageFeatures(
  chunks: readonly WebpChunk[],
): SimpleImageFeatures {
  const imageChunks = chunks.filter(
    ({ fourcc }) => fourcc === "VP8 " || fourcc === "VP8L",
  );
  if (imageChunks.length !== 1) {
    throw corruptContainer(
      "WebP without VP8X must contain one simple VP8 or VP8L image",
    );
  }

  const image = imageChunks[0]!;
  const features = image.fourcc === "VP8 "
    ? parseVp8Dimensions(image.data)
    : parseVp8lDimensions(image.data);
  const alphaChunks = chunks.filter(({ fourcc }) => fourcc === "ALPH");
  if (alphaChunks.length > 1) {
    throw corruptContainer("WebP contains more than one top-level ALPH chunk");
  }

  const alpha = alphaChunks[0] ?? null;
  if (alpha !== null) {
    if (alpha.data.length < 1) {
      throw corruptContainer("WebP ALPH chunk must contain a header byte");
    }
    if (
      image.fourcc !== "VP8 " ||
      chunks.indexOf(alpha) > chunks.indexOf(image)
    ) {
      throw corruptContainer(
        "WebP ALPH chunk must occur before one VP8 image",
      );
    }
  }

  return {
    ...features,
    alpha: features.alpha || alpha !== null,
  };
}

function vp8xCanvas(vp8x: WebpChunk): CanvasDimensions {
  const width = readUint24Le(vp8x.data, 4) + 1;
  const height = readUint24Le(vp8x.data, 7) + 1;
  if (width * height > MAX_VP8X_CANVAS_PIXELS) {
    throw corruptContainer(
      "WebP VP8X canvas exceeds the uint32 pixel-count limit",
    );
  }
  return { width, height };
}

function validateStaticExtendedWebp(
  parsed: ParsedWebp,
  canvas: CanvasDimensions,
): void {
  const features = simpleImageFeatures(parsed.chunks);
  if (features.width !== canvas.width || features.height !== canvas.height) {
    throw corruptContainer(
      "WebP static image dimensions do not match the VP8X canvas",
    );
  }

  const alphaFlag =
    (parsed.vp8x!.data[0]! & VP8X_ALPHA_FLAG) !== 0;
  if (alphaFlag !== features.alpha) {
    throw corruptContainer(
      "WebP VP8X alpha flag does not match the static image features",
    );
  }
}

function validateNestedFrameChunks(
  frame: WebpChunk,
  canvas: CanvasDimensions,
  budget: ChunkParsingBudget,
): boolean {
  const data = frame.data;
  if (data.length < 16) {
    throw corruptContainer("WebP ANMF frame header is truncated");
  }
  if ((data[15]! & 0xfc) !== 0) {
    throw corruptContainer("WebP ANMF frame header has reserved flag bits");
  }

  const x = readUint24Le(data, 0) * 2;
  const y = readUint24Le(data, 3) * 2;
  const width = readUint24Le(data, 6) + 1;
  const height = readUint24Le(data, 9) + 1;
  if (width === 0 || height === 0) {
    throw corruptContainer("WebP ANMF frame dimensions must be nonzero");
  }
  if (
    width > canvas.width ||
    height > canvas.height ||
    x > canvas.width - width ||
    y > canvas.height - height
  ) {
    throw corruptContainer("WebP ANMF frame rectangle exceeds the VP8X canvas");
  }

  let offset = 16;
  let alphaSeen = false;
  let imageFeatures: SimpleImageFeatures | null = null;

  while (offset < data.length) {
    const remaining = data.length - offset;
    if (remaining < CHUNK_HEADER_BYTES) {
      throw corruptContainer("WebP ANMF nested chunk header is truncated");
    }
    consumeChunkBudget(budget);

    const payloadLength = readUint32Le(data, offset + 4);
    const padLength = payloadLength & 1;
    const availablePayloadBytes =
      remaining - CHUNK_HEADER_BYTES - padLength;
    if (
      availablePayloadBytes < 0 ||
      payloadLength > availablePayloadBytes
    ) {
      throw corruptContainer(
        "WebP ANMF nested chunk data or pad extends beyond the frame",
      );
    }

    const fourcc = readFourcc(data, offset);
    const payloadStart = offset + CHUNK_HEADER_BYTES;
    const payloadEnd = payloadStart + payloadLength;
    const payload = data.subarray(payloadStart, payloadEnd);

    if (fourcc === "ALPH") {
      if (alphaSeen || imageFeatures !== null || payload.length < 1) {
        throw corruptContainer(
          "WebP ANMF permits one nonempty ALPH chunk before VP8",
        );
      }
      alphaSeen = true;
    } else if (fourcc === "VP8 " || fourcc === "VP8L") {
      if (imageFeatures !== null || (fourcc === "VP8L" && alphaSeen)) {
        throw corruptContainer(
          "WebP ANMF must contain exactly one VP8 or VP8L image",
        );
      }
      imageFeatures =
        fourcc === "VP8 "
          ? parseVp8Dimensions(payload)
          : parseVp8lDimensions(payload);
    } else if (
      imageFeatures === null ||
      DEFINED_WEBP_CHUNK_TYPES.has(fourcc)
    ) {
      throw corruptContainer(
        "WebP ANMF unknown nested chunks are only allowed after its image",
      );
    }

    offset = payloadEnd + padLength;
  }

  if (imageFeatures === null) {
    throw corruptContainer(
      "WebP ANMF must contain exactly one VP8 or VP8L image",
    );
  }
  if (
    imageFeatures.width !== width ||
    imageFeatures.height !== height
  ) {
    throw corruptContainer(
      "WebP ANMF image dimensions do not match its frame header",
    );
  }

  return alphaSeen || imageFeatures.alpha;
}

function validateAnimatedWebp(
  parsed: ParsedWebp,
  canvas: CanvasDimensions,
  budget: ChunkParsingBudget,
): void {
  const animChunks = parsed.chunks.filter(
    ({ fourcc }) => fourcc === "ANIM",
  );
  const frameChunks = parsed.chunks.filter(
    ({ fourcc }) => fourcc === "ANMF",
  );
  if (animChunks.length !== 1 || frameChunks.length < 1) {
    throw corruptContainer(
      "Animated WebP requires exactly one ANIM and at least one ANMF chunk",
    );
  }
  if (animChunks[0]!.data.length !== 6) {
    throw corruptContainer("WebP ANIM chunk must contain exactly 6 bytes");
  }

  let animSeen = false;
  for (const chunk of parsed.chunks) {
    if (chunk.fourcc === "ANIM") {
      animSeen = true;
    } else if (chunk.fourcc === "ANMF" && !animSeen) {
      throw corruptContainer("WebP ANIM chunk must precede all ANMF frames");
    }
  }
  if (
    parsed.chunks.some(
      ({ fourcc }) =>
        fourcc === "VP8 " || fourcc === "VP8L" || fourcc === "ALPH",
    )
  ) {
    throw corruptContainer(
      "Animated WebP cannot contain a top-level static image",
    );
  }

  let hasAlpha = false;
  for (const frame of frameChunks) {
    hasAlpha =
      validateNestedFrameChunks(frame, canvas, budget) || hasAlpha;
  }
  const alphaFlag =
    (parsed.vp8x!.data[0]! & VP8X_ALPHA_FLAG) !== 0;
  if (alphaFlag !== hasAlpha) {
    throw corruptContainer(
      "WebP VP8X alpha flag does not match its animation frames",
    );
  }
}

function validateWebpStructure(
  parsed: ParsedWebp,
  budget: ChunkParsingBudget,
): void {
  validateKnownMetadataStructure(parsed);

  const animChunks = parsed.chunks.filter(
    ({ fourcc }) => fourcc === "ANIM",
  );
  const frameChunks = parsed.chunks.filter(
    ({ fourcc }) => fourcc === "ANMF",
  );
  for (const anim of animChunks) {
    if (anim.data.length !== 6) {
      throw corruptContainer("WebP ANIM chunk must contain exactly 6 bytes");
    }
  }

  if (parsed.vp8x === null) {
    if (animChunks.length > 0 || frameChunks.length > 0) {
      throw corruptContainer("Animated WebP requires a VP8X chunk");
    }
    return;
  }

  const canvas = vp8xCanvas(parsed.vp8x);
  const animationFlag =
    (parsed.vp8x.data[0]! & VP8X_ANIMATION_FLAG) !== 0;
  if (animationFlag) {
    validateAnimatedWebp(parsed, canvas, budget);
  } else {
    if (animChunks.length > 0 || frameChunks.length > 0) {
      throw corruptContainer(
        "WebP animation chunks require the VP8X animation flag",
      );
    }
    validateStaticExtendedWebp(parsed, canvas);
  }
}

function validateKnownMetadataStructure(parsed: ParsedWebp): void {
  const iccpChunks = parsed.chunks.filter(
    ({ fourcc }) => fourcc === "ICCP",
  );
  const exifChunks = parsed.chunks.filter(
    ({ fourcc }) => fourcc === "EXIF",
  );
  if (iccpChunks.length > 1) {
    throw corruptContainer("WebP contains more than one ICCP chunk");
  }
  if (exifChunks.length > 1) {
    throw corruptContainer("WebP contains more than one EXIF chunk");
  }

  const topLevelImages = parsed.chunks.filter(
    ({ fourcc }) => fourcc === "VP8 " || fourcc === "VP8L",
  );
  const frames = parsed.chunks.filter(
    ({ fourcc }) => fourcc === "ANMF",
  );
  const knownMetadataPresent =
    iccpChunks.length > 0 || exifChunks.length > 0 || parsed.xmp !== null;
  const firstImageDataIndex = parsed.chunks.findIndex(
    ({ fourcc }) =>
      fourcc === "ALPH" ||
      fourcc === "VP8 " ||
      fourcc === "VP8L" ||
      fourcc === "ANIM" ||
      fourcc === "ANMF",
  );
  if (
    knownMetadataPresent &&
    topLevelImages.length === 0 &&
    frames.length === 0
  ) {
    throw corruptContainer("WebP metadata requires image or animation data");
  }

  const iccp = iccpChunks[0] ?? null;
  if (
    iccp !== null &&
    firstImageDataIndex >= 0 &&
    parsed.chunks.indexOf(iccp) >= firstImageDataIndex
  ) {
    throw corruptContainer(
      "WebP ICCP chunk must precede image or animation data",
    );
  }
  const exif = exifChunks[0] ?? null;

  if (parsed.vp8x !== null) {
    const flags = parsed.vp8x.data[0]!;
    const flagMatches = (flag: number, present: boolean): boolean =>
      ((flags & flag) !== 0) === present;
    if (!flagMatches(VP8X_ICC_FLAG, iccp !== null)) {
      throw corruptContainer(
        "WebP VP8X ICC flag does not match ICCP chunk presence",
      );
    }
    if (!flagMatches(VP8X_EXIF_FLAG, exif !== null)) {
      throw corruptContainer(
        "WebP VP8X EXIF flag does not match EXIF chunk presence",
      );
    }
    if (!flagMatches(VP8X_XMP_FLAG, parsed.xmp !== null)) {
      throw corruptContainer(
        "WebP VP8X XMP flag does not match XMP chunk presence",
      );
    }
  }
}

function synthesizeVp8x(
  parsed: ParsedWebp,
  features: SimpleImageFeatures,
): Uint8Array {
  let flags = VP8X_XMP_FLAG;
  if (features.alpha || parsed.chunks.some(({ fourcc }) => fourcc === "ALPH")) {
    flags |= VP8X_ALPHA_FLAG;
  }
  if (parsed.chunks.some(({ fourcc }) => fourcc === "ICCP")) {
    flags |= VP8X_ICC_FLAG;
  }
  if (parsed.chunks.some(({ fourcc }) => fourcc === "EXIF")) {
    flags |= VP8X_EXIF_FLAG;
  }
  if (
    parsed.chunks.some(
      ({ fourcc }) => fourcc === "ANIM" || fourcc === "ANMF",
    )
  ) {
    flags |= VP8X_ANIMATION_FLAG;
  }

  const data = new Uint8Array(VP8X_DATA_BYTES);
  data[0] = flags;
  writeUint24Le(data, 4, features.width - 1);
  writeUint24Le(data, 7, features.height - 1);
  return encodeChunk("VP8X", data);
}

function updatedVp8x(chunk: WebpChunk): Uint8Array {
  const raw = chunk.raw.slice();
  raw[CHUNK_HEADER_BYTES] = raw[CHUNK_HEADER_BYTES]! | VP8X_XMP_FLAG;
  return raw;
}

function insertionIndex(chunks: readonly WebpChunk[]): number {
  const standardBeforeXmp = new Set([
    "VP8X",
    "ICCP",
    "ANIM",
    "ANMF",
    "ALPH",
    "VP8 ",
    "VP8L",
    "EXIF",
  ]);
  let index = 0;

  for (let candidate = 0; candidate < chunks.length; candidate += 1) {
    if (standardBeforeXmp.has(chunks[candidate]!.fourcc)) {
      index = candidate + 1;
    }
  }

  return index;
}

function assembleWebp(chunks: readonly Uint8Array[]): Uint8Array {
  let chunksLength = 0;
  for (const chunk of chunks) {
    chunksLength += chunk.length;
    if (!Number.isSafeInteger(chunksLength)) {
      throw corruptContainer("WebP output size exceeds safe integer bounds");
    }
  }

  const outputLength = RIFF_HEADER_BYTES + chunksLength;
  const riffSize = outputLength - 8;
  if (riffSize > MAX_RIFF_SIZE) {
    throw corruptContainer("WebP output exceeds the uint32 RIFF size limit");
  }

  const output = new Uint8Array(outputLength);
  output.set([0x52, 0x49, 0x46, 0x46], 0);
  writeUint32Le(output, 4, riffSize);
  output.set([0x57, 0x45, 0x42, 0x50], 8);

  let offset = RIFF_HEADER_BYTES;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export function listWebpChunks(bytes: Uint8Array): WebpChunk[] {
  return parseWebp(bytes).chunks;
}

export function readWebpXmp(bytes: Uint8Array): string | null {
  const { xmp } = parseWebp(bytes);
  return xmp === null ? null : decodeXmpChunk(xmp);
}

export function writeWebpXmp(
  bytes: Uint8Array,
  packet: string,
): Uint8Array {
  const replacement = encodeXmpChunk(packet);
  const parsed = parseWebp(bytes);
  if (parsed.xmp !== null) {
    decodeXmpChunk(parsed.xmp);
  }

  const additions =
    (parsed.xmp === null ? 1 : 0) + (parsed.vp8x === null ? 1 : 0);
  if (parsed.parsedChunkCount + additions > MAX_WEBP_CHUNKS) {
    throw chunkLimitExceeded();
  }

  const outputChunks: Uint8Array[] = [];
  if (parsed.vp8x === null) {
    outputChunks.push(
      synthesizeVp8x(parsed, simpleImageFeatures(parsed.chunks)),
    );
  }

  const newXmpIndex =
    parsed.xmp === null ? insertionIndex(parsed.chunks) : -1;
  for (let index = 0; index < parsed.chunks.length; index += 1) {
    if (index === newXmpIndex) {
      outputChunks.push(replacement);
    }

    const chunk = parsed.chunks[index]!;
    if (chunk === parsed.vp8x) {
      outputChunks.push(updatedVp8x(chunk));
    } else if (chunk === parsed.xmp) {
      outputChunks.push(replacement);
    } else {
      outputChunks.push(chunk.raw);
    }
  }
  if (newXmpIndex === parsed.chunks.length) {
    outputChunks.push(replacement);
  }

  return assembleWebp(outputChunks);
}

export function isAnimatedWebp(bytes: Uint8Array): boolean {
  const parsed = parseWebp(bytes);
  return (
    (parsed.vp8x !== null &&
      (parsed.vp8x.data[0]! & VP8X_ANIMATION_FLAG) !== 0) ||
    parsed.chunks.some(
      ({ fourcc }) => fourcc === "ANIM" || fourcc === "ANMF",
    )
  );
}

export function inspectWebp(bytes: Uint8Array): WebpInspection {
  const parsed = parseWebp(bytes);
  const animated =
    (parsed.vp8x !== null &&
      (parsed.vp8x.data[0]! & VP8X_ANIMATION_FLAG) !== 0) ||
    parsed.chunks.some(
      ({ fourcc }) => fourcc === "ANIM" || fourcc === "ANMF",
    );
  const dimensions = parsed.vp8x === null
    ? simpleImageFeatures(parsed.chunks)
    : vp8xCanvas(parsed.vp8x);
  const exif = parsed.chunks.find(({ fourcc }) => fourcc === "EXIF");
  let orientation: ExifOrientation = 1;
  if (exif !== undefined) {
    try {
      orientation = readExifOrientation(exif.data);
    } catch (error) {
      throw corruptContainer(
        `WebP EXIF orientation metadata is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return {
    width: dimensions.width,
    height: dimensions.height,
    animated,
    orientation,
  };
}
