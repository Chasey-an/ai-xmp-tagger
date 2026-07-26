import type {
  ProcessRequest,
  ProcessResult,
} from "../core/process-file";
import type { ProcessingErrorCode } from "../core/errors";

export type WorkerRequest =
  | {
      type: "process";
      requestId: string;
      payload: ProcessRequest;
    }
  | {
      type: "ping";
      requestId: string;
    };

export type WorkerResponse =
  | {
      type: "result";
      requestId: string;
      payload: ProcessResult;
    }
  | {
      type: "error";
      requestId: string;
      error: {
        code: ProcessingErrorCode;
        message: string;
      };
    }
  | {
      type: "pong";
      requestId: string;
    };

const RESULT_STATES = new Set<ProcessResult["state"]>([
  "success",
  "checked",
  "failed",
  "cancelled",
]);
const OUTPUT_FORMATS = new Set<NonNullable<ProcessResult["outputFormat"]>>([
  "jpeg",
  "png",
  "webp",
  "bmp",
]);

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

/**
 * Runtime validation is required because worker messages and injected clients
 * cross a boundary where TypeScript types provide no protection.
 */
export function isProcessResult(
  value: unknown,
  expectedId?: string,
): value is ProcessResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const result = value as Record<string, unknown>;
  if (
    typeof result.id !== "string" ||
    (expectedId !== undefined && result.id !== expectedId) ||
    typeof result.state !== "string" ||
    !RESULT_STATES.has(result.state as ProcessResult["state"]) ||
    typeof result.subjectExists !== "boolean" ||
    typeof result.targetTagCount !== "number" ||
    !Number.isInteger(result.targetTagCount) ||
    result.targetTagCount < 0 ||
    typeof result.reencoded !== "boolean" ||
    typeof result.message !== "string" ||
    typeof result.elapsedMs !== "number" ||
    !Number.isFinite(result.elapsedMs) ||
    result.elapsedMs < 0
  ) {
    return false;
  }
  if (!result.subjectExists && result.targetTagCount !== 0) {
    return false;
  }

  const outputNameValid =
    result.outputName === null || typeof result.outputName === "string";
  const outputFormatValid =
    result.outputFormat === null ||
    (typeof result.outputFormat === "string" &&
      OUTPUT_FORMATS.has(
        result.outputFormat as NonNullable<ProcessResult["outputFormat"]>,
      ));
  if (!outputNameValid || !outputFormatValid) {
    return false;
  }

  if (result.state === "success") {
    return (
      isBlob(result.output) &&
      result.outputFormat !== null &&
      result.outputFormat !== "bmp" &&
      result.subjectExists === true &&
      result.targetTagCount === 1
    );
  }
  return (
    result.output === null &&
    result.outputFormat === null &&
    result.outputName === null &&
    result.reencoded === false
  );
}
