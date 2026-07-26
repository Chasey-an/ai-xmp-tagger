import {
  ProcessingError,
  type ProcessingErrorCode,
} from "../core/errors";
import { MAX_FILE_BYTES } from "../core/constants";
import {
  processFile,
  type ProcessRequest,
  type ProcessResult,
} from "../core/process-file";
import type {
  WorkerRequest,
  WorkerResponse,
} from "./protocol";

interface WorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  postMessage(message: WorkerResponse): void;
}

const scope = self as unknown as WorkerScope;
const IMAGE_FORMATS = new Set<ProcessRequest["format"]>([
  "jpeg",
  "png",
  "webp",
  "bmp",
]);
const PROCESSING_MODES = new Set<ProcessRequest["mode"]>([
  "jpeg-and-xmp",
  "original-and-xmp",
  "verify-only",
]);
const PROCESS_KEYS = ["payload", "requestId", "type"] as const;
const PING_KEYS = ["requestId", "type"] as const;
const PAYLOAD_KEYS = [
  "file",
  "format",
  "id",
  "mode",
  "relativePath",
] as const;

type ProcessFunction = (request: ProcessRequest) => Promise<ProcessResult>;
type PostResponse = (response: WorkerResponse) => void;

function safeWorkerError(error: unknown): {
  code: ProcessingErrorCode;
  message: string;
} {
  if (error instanceof ProcessingError) {
    switch (error.code) {
      case "CANCELLED":
        return { code: error.code, message: "处理已取消。" };
      case "LIMIT_EXCEEDED":
        return { code: error.code, message: "图片超过安全处理上限。" };
      case "UNSUPPORTED_FORMAT":
        return { code: error.code, message: "不支持该图片格式。" };
      default:
        return { code: error.code, message: "图片处理失败，请重试。" };
    }
  }
  return {
    code: "CORRUPT_CONTAINER",
    message: "后台处理失败，请重试。",
  };
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length &&
    keys.every((key, index) => actual[index] === key)
  );
}

function isSafeToken(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isSafeRelativePath(value: unknown): value is string {
  if (
    !isSafeToken(value, 4096) ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.includes("\\")
  ) {
    return false;
  }
  return !value.split("/").some((part) => part === "..");
}

function isSafeFile(value: unknown): value is File {
  if (
    typeof File === "undefined" ||
    !(value instanceof File) ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    value.size > MAX_FILE_BYTES ||
    !Number.isSafeInteger(value.lastModified) ||
    value.lastModified < 0
  ) {
    return false;
  }
  return (
    isSafeToken(value.name, 512) &&
    !value.name.includes("/") &&
    !value.name.includes("\\")
  );
}

function isProcessRequest(value: unknown): value is ProcessRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const payload = value as Record<string, unknown>;
  if (!hasExactKeys(payload, PAYLOAD_KEYS)) {
    return false;
  }
  return (
    isSafeToken(payload.id, 256) &&
    isSafeFile(payload.file) &&
    typeof payload.format === "string" &&
    IMAGE_FORMATS.has(payload.format as ProcessRequest["format"]) &&
    isSafeRelativePath(payload.relativePath) &&
    typeof payload.mode === "string" &&
    PROCESSING_MODES.has(payload.mode as ProcessRequest["mode"])
  );
}

function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (!isSafeToken(candidate.requestId, 256)) {
    return false;
  }
  if (candidate.type === "ping") {
    return hasExactKeys(candidate, PING_KEYS);
  }
  return (
    candidate.type === "process" &&
    hasExactKeys(candidate, PROCESS_KEYS) &&
    isProcessRequest(candidate.payload)
  );
}

function usableRequestId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const requestId = (value as Record<string, unknown>).requestId;
  return isSafeToken(requestId, 256) ? requestId : null;
}

function invalidRequestResponse(requestId: string): WorkerResponse {
  return {
    type: "error",
    requestId,
    error: {
      code: "CORRUPT_CONTAINER",
      message: "后台请求无效，请重试。",
    },
  };
}

export async function handleWorkerMessage(
  value: unknown,
  postResponse: PostResponse,
  process: ProcessFunction = processFile,
): Promise<void> {
  let validRequest = false;
  try {
    validRequest = isWorkerRequest(value);
  } catch {
    validRequest = false;
  }
  if (!validRequest) {
    let requestId: string | null = null;
    try {
      requestId = usableRequestId(value);
    } catch {
      requestId = null;
    }
    if (requestId !== null) {
      postResponse(invalidRequestResponse(requestId));
    }
    return;
  }
  const request = value as WorkerRequest;
  if (request.type === "ping") {
    postResponse({ type: "pong", requestId: request.requestId });
    return;
  }

  try {
    const result = await process(request.payload);
    postResponse({
      type: "result",
      requestId: request.requestId,
      payload: result,
    });
  } catch (error: unknown) {
    const safe = safeWorkerError(error);
    postResponse({
      type: "error",
      requestId: request.requestId,
      error: {
        code: safe.code,
        message: safe.message,
      },
    });
  }
}

// This module is a Vite Worker entry. The guard avoids installing a window
// message listener when the exported handler is imported by unit tests.
if (typeof document === "undefined") {
  scope.addEventListener("message", (event) => {
    void handleWorkerMessage(
      event.data,
      (response) => scope.postMessage(response),
    );
  });
}
