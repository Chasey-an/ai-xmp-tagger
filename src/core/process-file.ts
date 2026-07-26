import { decodeRaster as defaultDecodeRaster } from "./conversion/decode";
import {
  encodeHighQualityJpeg as defaultEncodeHighQualityJpeg,
  type RgbaImage,
} from "./conversion/jpeg";
import { ProcessingError } from "./errors";
import type {
  ImageFormat,
  ProcessingMode,
  SubjectCheck,
} from "./types";
import { readJpegXmp, writeJpegXmp } from "./xmp/jpeg";
import { createNormalizedPacket, inspectPacket } from "./xmp/model";
import { readPngXmp, writePngXmp } from "./xmp/png";
import {
  isAnimatedWebp,
  readWebpXmp,
  writeWebpXmp,
} from "./xmp/webp";

export type { ProcessingMode } from "./types";

export interface ProcessRequest {
  id: string;
  file: File;
  format: ImageFormat;
  relativePath: string;
  mode: ProcessingMode;
}

export interface ProcessResult {
  id: string;
  state: "success" | "checked" | "failed" | "cancelled";
  output: Blob | null;
  outputFormat: ImageFormat | null;
  outputName: string | null;
  subjectExists: boolean;
  targetTagCount: number;
  reencoded: boolean;
  message: string;
  elapsedMs: number;
}

export interface ProcessFileDependencies {
  decodeRaster?: (
    file: File,
    format: "png" | "webp" | "bmp",
  ) => Promise<RgbaImage>;
  encodeHighQualityJpeg?: (image: RgbaImage) => Promise<Uint8Array>;
  /**
   * Test-only fault-injection seam. Production callers should not set this.
   * The returned bytes are still checked by the real container reader.
   */
  beforeVerifyOutput?: (
    bytes: Uint8Array,
    format: Exclude<ImageFormat, "bmp">,
  ) => Uint8Array | Promise<Uint8Array>;
}

const SUPPORTED_FORMATS = new Set<ImageFormat>([
  "jpeg",
  "png",
  "webp",
  "bmp",
]);
const SUPPORTED_MODES = new Set<ProcessingMode>([
  "jpeg-and-xmp",
  "original-and-xmp",
  "verify-only",
]);

type XmpFormat = Exclude<ImageFormat, "bmp">;

interface WrittenOutput {
  bytes: Uint8Array;
  format: XmpFormat;
  reencoded: boolean;
}

class WrittenOutputVerificationError extends ProcessingError {
  constructor(readonly check: SubjectCheck) {
    super(
      "VERIFY_FAILED",
      `Written XMP target count was ${check.targetTagCount}`,
    );
  }
}

function elapsedSince(startedAt: number): number {
  const elapsed = performance.now() - startedAt;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
}

function emptyResult(
  id: string,
  startedAt: number,
  state: "failed" | "cancelled",
  message: string,
  check: SubjectCheck = {
    subjectExists: false,
    subjects: [],
    targetTagCount: 0,
  },
): ProcessResult {
  return {
    id,
    state,
    output: null,
    outputFormat: null,
    outputName: null,
    subjectExists: check.subjectExists,
    targetTagCount: check.targetTagCount,
    reencoded: false,
    message,
    elapsedMs: elapsedSince(startedAt),
  };
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  try {
    if (
      typeof file !== "object" ||
      file === null ||
      typeof file.arrayBuffer !== "function"
    ) {
      throw new TypeError("File.arrayBuffer is unavailable");
    }
    return new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    if (isCancellation(error)) {
      throw cancelled(error);
    }
    throw new ProcessingError(
      "CORRUPT_CONTAINER",
      "The selected file could not be read",
      { cause: error },
    );
  }
}

function readXmp(bytes: Uint8Array, format: XmpFormat): string | null {
  switch (format) {
    case "jpeg":
      return readJpegXmp(bytes);
    case "png":
      return readPngXmp(bytes);
    case "webp":
      return readWebpXmp(bytes);
  }
}

function writeXmp(
  bytes: Uint8Array,
  format: XmpFormat,
  packet: string,
): Uint8Array {
  switch (format) {
    case "jpeg":
      return writeJpegXmp(bytes, packet);
    case "png":
      return writePngXmp(bytes, packet);
    case "webp":
      return writeWebpXmp(bytes, packet);
  }
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function minimalSubjectPacket(subjects: readonly string[]): string {
  const items = subjects
    .map((subject) => `<rdf:li>${escapeXmlText(subject)}</rdf:li>`)
    .join("");
  return [
    '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    `<dc:subject><rdf:Bag>${items}</rdf:Bag></dc:subject>`,
    "</rdf:Description></rdf:RDF></x:xmpmeta>",
    '<?xpacket end="w"?>',
  ].join("");
}

function normalizedConversionPacket(sourcePacket: string | null): string {
  if (sourcePacket === null) {
    return createNormalizedPacket(null);
  }
  const { subjects } = inspectPacket(sourcePacket);
  return createNormalizedPacket(minimalSubjectPacket(subjects));
}

function originalWrite(
  bytes: Uint8Array,
  format: XmpFormat,
): WrittenOutput {
  const normalized = createNormalizedPacket(readXmp(bytes, format));
  return {
    bytes: writeXmp(bytes, format, normalized),
    format,
    reencoded: false,
  };
}

async function convertedWrite(
  request: ProcessRequest,
  bytes: Uint8Array,
  dependencies: ProcessFileDependencies,
): Promise<WrittenOutput> {
  if (request.format === "jpeg") {
    return originalWrite(bytes, "jpeg");
  }

  if (request.format === "webp" && isAnimatedWebp(bytes)) {
    throw new ProcessingError(
      "UNSUPPORTED_FORMAT",
      "Animated WebP conversion is not supported",
    );
  }

  const sourcePacket =
    request.format === "bmp" ? null : readXmp(bytes, request.format);
  const normalized = normalizedConversionPacket(sourcePacket);
  const decodeRaster = dependencies.decodeRaster ?? defaultDecodeRaster;
  const encodeHighQualityJpeg =
    dependencies.encodeHighQualityJpeg ?? defaultEncodeHighQualityJpeg;

  let decoded: RgbaImage;
  try {
    decoded = await decodeRaster(
      request.file,
      request.format,
    );
  } catch (error) {
    if (isCancellation(error)) {
      throw cancelled(error);
    }
    throw error;
  }

  let encoded: Uint8Array;
  try {
    encoded = await encodeHighQualityJpeg(decoded);
  } catch (error) {
    if (isCancellation(error)) {
      throw cancelled(error);
    }
    throw error;
  }

  return {
    bytes: writeJpegXmp(encoded, normalized),
    format: "jpeg",
    reencoded: true,
  };
}

async function verifyWrittenOutput(
  written: WrittenOutput,
  dependencies: ProcessFileDependencies,
): Promise<{ bytes: Uint8Array; check: SubjectCheck }> {
  const bytes =
    dependencies.beforeVerifyOutput === undefined
      ? written.bytes
      : await dependencies.beforeVerifyOutput(
          written.bytes,
          written.format,
        );
  const check = inspectPacket(readXmp(bytes, written.format));
  if (check.targetTagCount !== 1) {
    throw new WrittenOutputVerificationError(check);
  }
  return { bytes, check };
}

function outputBlob(bytes: Uint8Array, format: XmpFormat): Blob {
  const type =
    format === "jpeg" ? "image/jpeg" : `image/${format}`;
  return new Blob([bytes.slice().buffer], { type });
}

function successMessage(reencoded: boolean): string {
  return reencoded
    ? "已转换为高清 JPEG，并写入及验证 XMP 标签。"
    : "已写入并验证 XMP dc:subject 标签。";
}

function checkedMessage(check: SubjectCheck): string {
  return check.targetTagCount > 0
    ? `已检查：XMP dc:subject 中存在 ${check.targetTagCount} 个目标标签。`
    : "已检查：XMP dc:subject 中未发现目标标签。";
}

function isCancellation(error: unknown): boolean {
  return (
    (error instanceof ProcessingError && error.code === "CANCELLED") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function cancelled(cause: unknown): ProcessingError {
  return new ProcessingError("CANCELLED", "Processing was cancelled", {
    cause,
  });
}

function safeMessage(error: unknown): string {
  if (isCancellation(error)) {
    return "处理已取消。";
  }
  if (!(error instanceof ProcessingError)) {
    return "处理失败，请重试；如仍失败，请重新导出图片。";
  }

  switch (error.code) {
    case "UNSUPPORTED_FORMAT":
      return /Animated WebP/.test(error.message)
        ? "暂不支持动态 WebP 转换，请先导出为静态图片后重试。"
        : "不支持该图片格式，请使用 JPEG、PNG、WebP 或 BMP。";
    case "LIMIT_EXCEEDED":
      return "图片超过安全处理上限，请缩小尺寸或减少元数据后重试。";
    case "CORRUPT_CONTAINER":
      return "图片文件可能已损坏或格式不完整，请重新导出后再试。";
    case "INVALID_XMP":
      return "图片中的 XMP 元数据无效，请先清理元数据或重新导出图片。";
    case "XMP_CONFLICT":
      return "图片包含冲突的 XMP 数据，暂时无法安全处理。";
    case "EXTENDED_XMP_UNSUPPORTED":
      return "图片使用了暂不支持的扩展 XMP，请先重新导出图片。";
    case "DECODE_FAILED":
      return "图片解码失败，请确认文件完整并重新导出后再试。";
    case "ENCODE_FAILED":
      return "高清 JPEG 编码失败，请重试或更换源图片。";
    case "VERIFY_FAILED":
      return "标签写入后的验证未通过，未生成输出文件，请重试。";
    case "CANCELLED":
      return "处理已取消。";
  }
}

export async function processFile(
  request: ProcessRequest,
  dependencies: ProcessFileDependencies = {},
): Promise<ProcessResult> {
  const startedAt = performance.now();
  let latestCheck: SubjectCheck = {
    subjectExists: false,
    subjects: [],
    targetTagCount: 0,
  };

  try {
    if (!SUPPORTED_FORMATS.has(request.format)) {
      throw new ProcessingError(
        "UNSUPPORTED_FORMAT",
        "Runtime image format is unsupported",
      );
    }
    if (!SUPPORTED_MODES.has(request.mode)) {
      throw new ProcessingError(
        "UNSUPPORTED_FORMAT",
        "Runtime processing mode is unsupported",
      );
    }
    if (request.format === "bmp" && request.mode === "original-and-xmp") {
      return emptyResult(
        request.id,
        startedAt,
        "failed",
        "BMP 不支持“保持原格式并写入标签”模式，请使用“转为高清 JPEG 并写入标签”。",
      );
    }
    if (request.format === "bmp" && request.mode === "verify-only") {
      return emptyResult(
        request.id,
        startedAt,
        "failed",
        "BMP 不包含受支持的 XMP 标签位置，无法使用“仅检查标签”模式。",
      );
    }

    const bytes = await readFileBytes(request.file);

    if (request.mode === "verify-only") {
      latestCheck = inspectPacket(readXmp(bytes, request.format as XmpFormat));
      return {
        id: request.id,
        state: "checked",
        output: null,
        outputFormat: null,
        outputName: null,
        subjectExists: latestCheck.subjectExists,
        targetTagCount: latestCheck.targetTagCount,
        reencoded: false,
        message: checkedMessage(latestCheck),
        elapsedMs: elapsedSince(startedAt),
      };
    }

    const written =
      request.mode === "original-and-xmp"
        ? originalWrite(bytes, request.format as XmpFormat)
        : await convertedWrite(request, bytes, dependencies);
    const verified = await verifyWrittenOutput(written, dependencies);
    latestCheck = verified.check;

    return {
      id: request.id,
      state: "success",
      output: outputBlob(verified.bytes, written.format),
      outputFormat: written.format,
      // Task 10 is the only security-authoritative output-name owner.
      outputName: null,
      subjectExists: latestCheck.subjectExists,
      targetTagCount: latestCheck.targetTagCount,
      reencoded: written.reencoded,
      message: successMessage(written.reencoded),
      elapsedMs: elapsedSince(startedAt),
    };
  } catch (error) {
    const state = isCancellation(error) ? "cancelled" : "failed";
    if (error instanceof WrittenOutputVerificationError) {
      latestCheck = error.check;
    }
    return emptyResult(
      request.id,
      startedAt,
      state,
      safeMessage(error),
      latestCheck,
    );
  }
}
