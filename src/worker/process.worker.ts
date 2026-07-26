import {
  ProcessingError,
  type ProcessingErrorCode,
} from "../core/errors";
import { processFile } from "../core/process-file";
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

function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.requestId !== "string") {
    return false;
  }
  return (
    candidate.type === "ping" ||
    (candidate.type === "process" &&
      typeof candidate.payload === "object" &&
      candidate.payload !== null)
  );
}

scope.addEventListener("message", (event) => {
  const request = event.data;
  if (!isWorkerRequest(request)) {
    return;
  }
  if (request.type === "ping") {
    scope.postMessage({ type: "pong", requestId: request.requestId });
    return;
  }

  void processFile(request.payload)
    .then((result) => {
      scope.postMessage({
        type: "result",
        requestId: request.requestId,
        result,
      });
    })
    .catch((error: unknown) => {
      const safe = safeWorkerError(error);
      scope.postMessage({
        type: "error",
        requestId: request.requestId,
        code: safe.code,
        message: safe.message,
      });
    });
});
