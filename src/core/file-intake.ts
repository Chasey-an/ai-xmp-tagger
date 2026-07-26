import {
  MAX_BATCH_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
} from "./constants";
import { ProcessingError } from "./errors";
import type { ImageFormat } from "./types";

const HEADER_BYTES = 32;
const COUNT_WARNING_THRESHOLD = 100;
const BATCH_WARNING_BYTES = 250 * 1024 * 1024;

export interface SelectedImage {
  id: string;
  file: File;
  format: ImageFormat;
  relativePath: string;
  warning: string | null;
}

let fallbackIdSequence = 0;

function unsupportedFormat(message = "不支持的图片格式或文件头不完整"): ProcessingError {
  return new ProcessingError("UNSUPPORTED_FORMAT", message);
}

function limitExceeded(message: string): ProcessingError {
  return new ProcessingError("LIMIT_EXCEEDED", message);
}

function validateFileSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw limitExceeded("文件大小无效，无法处理");
  }
  if (size === 0) {
    throw unsupportedFormat("文件为空，无法识别图片格式");
  }
  if (size > MAX_FILE_BYTES) {
    throw limitExceeded("单个文件超过 50 MiB 限制");
  }
}

function hasBytes(
  bytes: Uint8Array,
  offset: number,
  expected: readonly number[],
): boolean {
  return (
    bytes.byteLength >= offset + expected.length &&
    expected.every((value, index) => bytes[offset + index] === value)
  );
}

function detectFormat(bytes: Uint8Array): ImageFormat {
  if (hasBytes(bytes, 0, [0xff, 0xd8, 0xff])) {
    return "jpeg";
  }
  if (hasBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "png";
  }
  if (hasBytes(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && hasBytes(bytes, 8, [0x57, 0x45, 0x42, 0x50])) {
    return "webp";
  }
  if (hasBytes(bytes, 0, [0x42, 0x4d])) {
    return "bmp";
  }
  throw unsupportedFormat();
}

function extensionMatches(name: string, format: ImageFormat): boolean {
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  switch (format) {
    case "jpeg":
      return extension === ".jpg" || extension === ".jpeg";
    case "png":
      return extension === ".png";
    case "webp":
      return extension === ".webp";
    case "bmp":
      return extension === ".bmp";
  }
}

function normalizeRelativePath(path: string, fileName: string): string {
  // Intake normalization is intentionally limited; Task 10 owns output-path security.
  const normalized = path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
  return normalized || fileName;
}

function createId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === "function") {
    return randomUUID.call(globalThis.crypto);
  }

  fallbackIdSequence += 1;
  return `local-id-${fallbackIdSequence}`;
}

async function readHeader(file: File): Promise<Uint8Array> {
  try {
    return new Uint8Array(
      await file.slice(0, HEADER_BYTES).arrayBuffer(),
    );
  } catch (error) {
    if (error instanceof ProcessingError) {
      throw error;
    }
    throw new ProcessingError(
      "CORRUPT_CONTAINER",
      "读取文件头失败，文件可能已损坏或无法访问",
      { cause: error },
    );
  }
}

function selectedImageIdentity(image: SelectedImage): string {
  const { file, relativePath } = image;
  return JSON.stringify([
    relativePath,
    file.name,
    file.size,
    file.lastModified,
  ]);
}

export async function inspectSelectedFile(
  file: File,
  relativePath: string,
): Promise<SelectedImage> {
  validateFileSize(file.size);
  const bytes = await readHeader(file);
  const format = detectFormat(bytes);
  const resolvedRelativePath = normalizeRelativePath(
    relativePath || file.webkitRelativePath || file.name,
    file.name,
  );

  return {
    id: createId(),
    file,
    format,
    relativePath: resolvedRelativePath,
    warning: extensionMatches(file.name, format) ? null : "扩展名与文件内容不一致",
  };
}

export function mergeSelectedImages(
  current: SelectedImage[],
  incoming: SelectedImage[],
): SelectedImage[] {
  const identities = new Set<string>();
  const merged: SelectedImage[] = [];

  for (const image of [...current, ...incoming]) {
    const identity = selectedImageIdentity(image);
    if (!identities.has(identity)) {
      identities.add(identity);
      merged.push(image);
    }
  }

  return merged;
}

export function applyBatchPolicy(files: SelectedImage[]): {
  totalBytes: number;
  warning: string | null;
} {
  if (files.length > MAX_FILES) {
    throw limitExceeded(`文件数量超过 ${MAX_FILES} 个限制`);
  }

  let totalBytes = 0;
  for (const image of files) {
    validateFileSize(image.file.size);
    if (totalBytes > Number.MAX_SAFE_INTEGER - image.file.size) {
      throw limitExceeded("批次文件总大小无效，无法处理");
    }
    totalBytes += image.file.size;
    if (totalBytes > MAX_BATCH_BYTES) {
      throw limitExceeded("批次文件总大小超过 500 MiB 限制");
    }
  }

  const countWarning = files.length > COUNT_WARNING_THRESHOLD;
  const sizeWarning = totalBytes > BATCH_WARNING_BYTES;
  let warning: string | null = null;
  if (countWarning && sizeWarning) {
    warning = "文件数量超过 100 个，合计大小超过 250 MiB";
  } else if (countWarning) {
    warning = "文件数量超过 100 个";
  } else if (sizeWarning) {
    warning = "合计大小超过 250 MiB";
  }

  return { totalBytes, warning };
}
