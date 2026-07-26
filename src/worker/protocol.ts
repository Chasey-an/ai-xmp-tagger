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
      result: ProcessResult;
    }
  | {
      type: "error";
      requestId: string;
      code: ProcessingErrorCode;
      message: string;
    }
  | {
      type: "pong";
      requestId: string;
    };
