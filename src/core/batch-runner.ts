import { ProcessingError } from "./errors";
import type {
  ProcessRequest,
  ProcessResult,
} from "./process-file";
import {
  WorkerClient,
  type WorkerClientLike,
} from "../worker/client";
import { isProcessResult } from "../worker/protocol";

export interface BatchProgress {
  total: number;
  completed: number;
  success: number;
  checked: number;
  failed: number;
  cancelled: number;
  current: ProcessResult | null;
}

export interface BatchRunnerOptions {
  conversionClients?: readonly WorkerClientLike[];
  metadataClients?: readonly WorkerClientLike[];
}

interface ActiveRun {
  requests: readonly ProcessRequest[];
  results: Array<ProcessResult | undefined>;
  started: boolean[];
  settled: boolean[];
  cancelled: boolean;
  progress: BatchProgress;
  onProgress: (progress: BatchProgress) => void;
}

function isConversion(request: ProcessRequest): boolean {
  return (
    request.mode === "jpeg-and-xmp" &&
    request.format !== "jpeg"
  );
}

function cancellationResult(request: ProcessRequest): ProcessResult {
  return {
    id: request.id,
    state: "cancelled",
    output: null,
    outputFormat: null,
    outputName: null,
    subjectExists: false,
    targetTagCount: 0,
    reencoded: false,
    message: "处理已取消。",
    elapsedMs: 0,
  };
}

function failureResult(request: ProcessRequest): ProcessResult {
  return {
    id: request.id,
    state: "failed",
    output: null,
    outputFormat: null,
    outputName: null,
    subjectExists: false,
    targetTagCount: 0,
    reencoded: false,
    message: "处理失败，请重试。",
    elapsedMs: 0,
  };
}

function safeNotify(
  callback: (progress: BatchProgress) => void,
  progress: BatchProgress,
): void {
  try {
    callback({ ...progress });
  } catch {
    // Progress UI failures must not corrupt or stop image processing.
  }
}

export class BatchRunner {
  private readonly conversionClients: readonly WorkerClientLike[];
  private readonly metadataClients: readonly WorkerClientLike[];
  private active: ActiveRun | null = null;

  constructor(options: BatchRunnerOptions = {}) {
    this.conversionClients =
      options.conversionClients ?? [new WorkerClient()];
    this.metadataClients =
      options.metadataClients ?? [new WorkerClient(), new WorkerClient()];
    if (
      this.conversionClients.length !== 1 ||
      this.metadataClients.length < 1 ||
      this.metadataClients.length > 2
    ) {
      throw new RangeError(
        "BatchRunner requires exactly 1 conversion client and 1-2 metadata clients",
      );
    }
  }

  async run(
    requests: readonly ProcessRequest[],
    onProgress: (progress: BatchProgress) => void,
  ): Promise<ProcessResult[]> {
    if (this.active !== null) {
      throw new ProcessingError(
        "INVALID_MODE",
        "已有批次正在处理，请等待完成或先取消当前批次。",
      );
    }

    const context: ActiveRun = {
      requests,
      results: new Array<ProcessResult | undefined>(requests.length),
      started: new Array<boolean>(requests.length).fill(false),
      settled: new Array<boolean>(requests.length).fill(false),
      cancelled: false,
      progress: {
        total: requests.length,
        completed: 0,
        success: 0,
        checked: 0,
        failed: 0,
        cancelled: 0,
        current: null,
      },
      onProgress,
    };
    this.active = context;
    safeNotify(onProgress, context.progress);

    if (requests.length === 0) {
      this.active = null;
      return [];
    }

    const conversionQueue: number[] = [];
    const metadataQueue: number[] = [];
    requests.forEach((request, index) => {
      (isConversion(request) ? conversionQueue : metadataQueue).push(index);
    });

    try {
      await Promise.all([
        ...this.startLane(context, conversionQueue, this.conversionClients),
        ...this.startLane(context, metadataQueue, this.metadataClients),
      ]);
      if (context.cancelled) {
        requests.forEach((request, index) => {
          if (!context.settled[index]) {
            this.settle(context, index, cancellationResult(request));
          }
        });
      }
      return context.results as ProcessResult[];
    } finally {
      if (this.active === context) {
        this.active = null;
      }
    }
  }

  cancel(): void {
    const context = this.active;
    if (context === null || context.cancelled) {
      return;
    }
    context.cancelled = true;

    context.requests.forEach((request, index) => {
      if (!context.started[index] && !context.settled[index]) {
        this.settle(context, index, cancellationResult(request));
      }
    });
    for (const client of [
      ...this.conversionClients,
      ...this.metadataClients,
    ]) {
      client.cancelAll();
    }
  }

  private startLane(
    context: ActiveRun,
    queue: readonly number[],
    clients: readonly WorkerClientLike[],
  ): Array<Promise<void>> {
    let cursor = 0;
    return clients.map(async (client) => {
      while (!context.cancelled && cursor < queue.length) {
        const index = queue[cursor++]!;
        context.started[index] = true;
        const request = context.requests[index]!;
        try {
          const workerResult = await client.process(request);
          const finalResult = context.cancelled
            ? cancellationResult(request)
            : workerResult;
          this.settle(context, index, finalResult);
        } catch {
          this.settle(
            context,
            index,
            context.cancelled
              ? cancellationResult(request)
              : failureResult(request),
          );
        }
      }
    });
  }

  private settle(
    context: ActiveRun,
    index: number,
    result: ProcessResult,
  ): void {
    if (context.settled[index]) {
      return;
    }
    const expectedRequest = context.requests[index]!;
    const safeResult = isProcessResult(result, expectedRequest.id)
      ? result
      : failureResult(expectedRequest);
    context.settled[index] = true;
    context.results[index] = safeResult;
    context.progress.completed += 1;
    context.progress[safeResult.state] += 1;
    context.progress.current = safeResult;
    safeNotify(context.onProgress, context.progress);
  }
}
