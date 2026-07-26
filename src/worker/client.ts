import {
  ProcessingError,
  type ProcessingErrorCode,
} from "../core/errors";
import type {
  ProcessRequest,
  ProcessResult,
} from "../core/process-file";
import type {
  WorkerRequest,
  WorkerResponse,
} from "./protocol";
import { isProcessResult } from "./protocol";

type WorkerEventHandler = (event: MessageEvent | ErrorEvent) => void;

export interface WorkerLike {
  addEventListener(type: string, listener: WorkerEventHandler): void;
  removeEventListener(type: string, listener: WorkerEventHandler): void;
  postMessage(message: unknown): void;
  terminate(): void;
}

export interface WorkerClientLike {
  process(payload: ProcessRequest): Promise<ProcessResult>;
  cancelAll(): void;
  ping?(): Promise<void>;
}

type WorkerFactory = () => WorkerLike;

interface PendingResult {
  kind: "process";
  payloadId: string;
  resolve: (result: ProcessResult) => void;
  reject: (error: ProcessingError) => void;
}

interface PendingPing {
  kind: "ping";
  resolve: () => void;
  reject: (error: ProcessingError) => void;
}

type PendingRequest = PendingResult | PendingPing;

const ERROR_CODES = new Set<ProcessingErrorCode>([
  "UNSUPPORTED_FORMAT",
  "LIMIT_EXCEEDED",
  "CORRUPT_CONTAINER",
  "INVALID_XMP",
  "XMP_CONFLICT",
  "EXTENDED_XMP_UNSUPPORTED",
  "DECODE_FAILED",
  "ENCODE_FAILED",
  "VERIFY_FAILED",
  "INVALID_MODE",
  "CANCELLED",
]);

function defaultWorkerFactory(): WorkerLike {
  return new Worker(new URL("./process.worker.ts", import.meta.url), {
    type: "module",
    name: "xmp-processor",
  });
}

function startupError(cause?: unknown): ProcessingError {
  return new ProcessingError(
    "CORRUPT_CONTAINER",
    "后台处理器启动失败，请重试。",
    cause === undefined ? undefined : { cause },
  );
}

function runtimeError(cause?: unknown): ProcessingError {
  return new ProcessingError(
    "CORRUPT_CONTAINER",
    "后台处理器意外停止，请重试。",
    cause === undefined ? undefined : { cause },
  );
}

function cancelledError(): ProcessingError {
  return new ProcessingError("CANCELLED", "处理已取消。");
}

function isResponse(value: unknown): value is WorkerResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.type !== "string" ||
    typeof candidate.requestId !== "string"
  ) {
    return false;
  }
  switch (candidate.type) {
    case "pong":
      return true;
    case "result":
      return "payload" in candidate;
    case "error":
      if (typeof candidate.error !== "object" || candidate.error === null) {
        return false;
      }
      return (
        typeof (candidate.error as Record<string, unknown>).code === "string" &&
        ERROR_CODES.has(
          (candidate.error as Record<string, unknown>)
            .code as ProcessingErrorCode,
        ) &&
        typeof (candidate.error as Record<string, unknown>).message === "string"
      );
    default:
      return false;
  }
}

/**
 * A single reusable worker connection. Cancellation replaces the worker
 * generation, so subsequent requests never share state with cancelled work.
 */
export class WorkerClient implements WorkerClientLike {
  private worker: WorkerLike | null = null;
  private detachWorkerListeners: (() => void) | null = null;
  private generation = 0;
  private sequence = 0;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly createWorker: WorkerFactory = defaultWorkerFactory) {}

  process(payload: ProcessRequest): Promise<ProcessResult> {
    return this.send<ProcessResult>("process", payload);
  }

  ping(): Promise<void> {
    return this.send<void>("ping");
  }

  cancelAll(): void {
    this.rejectAll(cancelledError());
    this.destroyWorker();
    // Eager replacement makes readiness after cancellation deterministic.
    // A constructor failure is retried by the next request.
    try {
      this.ensureWorker();
    } catch {
      // The next ping/process call reports a safe startup error.
    }
  }

  private send<T>(
    kind: "process" | "ping",
    payload?: ProcessRequest,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let worker: WorkerLike;
      try {
        worker = this.ensureWorker();
      } catch (error) {
        reject(startupError(error));
        return;
      }

      const requestId = `${this.generation}:${++this.sequence}`;
      const pending: PendingRequest =
        kind === "process"
          ? {
              kind,
              payloadId: (payload as ProcessRequest).id,
              resolve: resolve as (result: ProcessResult) => void,
              reject,
            }
          : {
              kind,
              resolve: resolve as () => void,
              reject,
            };
      this.pending.set(requestId, pending);
      const request: WorkerRequest =
        kind === "process"
          ? {
              type: "process",
              requestId,
              payload: payload as ProcessRequest,
            }
          : { type: "ping", requestId };

      try {
        // No transfer list: File/Blob remains usable by the caller.
        worker.postMessage(request);
      } catch (error) {
        this.pending.delete(requestId);
        reject(runtimeError(error));
        this.failGeneration(runtimeError(error));
      }
    });
  }

  private ensureWorker(): WorkerLike {
    if (this.worker !== null) {
      return this.worker;
    }
    const generation = ++this.generation;
    let worker: WorkerLike;
    try {
      worker = this.createWorker();
    } catch (error) {
      this.worker = null;
      throw error;
    }

    const onMessage: WorkerEventHandler = (event) => {
      if (generation !== this.generation || worker !== this.worker) {
        return;
      }
      const response = (event as MessageEvent).data;
      if (!isResponse(response)) {
        this.failGeneration(runtimeError());
        return;
      }
      const pending = this.pending.get(response.requestId);
      if (pending === undefined) {
        return;
      }
      this.pending.delete(response.requestId);

      if (response.type === "error") {
        pending.reject(
          new ProcessingError(
            response.error.code,
            response.error.message,
          ),
        );
        return;
      }
      if (response.type === "pong" && pending.kind === "ping") {
        pending.resolve();
        return;
      }
      if (response.type === "result" && pending.kind === "process") {
        if (!isProcessResult(response.payload, pending.payloadId)) {
          const error = runtimeError();
          pending.reject(error);
          this.failGeneration(error);
          return;
        }
        pending.resolve(response.payload);
        return;
      }
      pending.reject(runtimeError());
    };
    const onError: WorkerEventHandler = (event) => {
      if (generation === this.generation && worker === this.worker) {
        this.failGeneration(runtimeError(event));
      }
    };
    const onMessageError: WorkerEventHandler = (event) => {
      if (generation === this.generation && worker === this.worker) {
        this.failGeneration(runtimeError(event));
      }
    };

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.addEventListener("messageerror", onMessageError);
    this.detachWorkerListeners = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("messageerror", onMessageError);
    };
    this.worker = worker;
    return worker;
  }

  private failGeneration(error: ProcessingError): void {
    this.rejectAll(error);
    this.destroyWorker();
  }

  private rejectAll(error: ProcessingError): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      request.reject(error);
    }
  }

  private destroyWorker(): void {
    const worker = this.worker;
    this.worker = null;
    this.detachWorkerListeners?.();
    this.detachWorkerListeners = null;
    this.generation += 1;
    worker?.terminate();
  }
}
