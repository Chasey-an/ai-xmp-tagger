import { describe, expect, it, vi } from "vitest";

import { BatchRunner, type BatchProgress } from "../../src/core/batch-runner";
import { ProcessingError } from "../../src/core/errors";
import type {
  ProcessRequest,
  ProcessResult,
} from "../../src/core/process-file";
import {
  WorkerClient,
  type WorkerClientLike,
  type WorkerLike,
} from "../../src/worker/client";

function request(
  id: string,
  format: ProcessRequest["format"] = "jpeg",
  mode: ProcessRequest["mode"] = "verify-only",
): ProcessRequest {
  return {
    id,
    file: new File([id], `${id}.${format}`, { type: `image/${format}` }),
    format,
    relativePath: `${id}.${format}`,
    mode,
  };
}

function result(
  id: string,
  state: ProcessResult["state"] = "checked",
): ProcessResult {
  const succeeded = state === "success";
  return {
    id,
    state,
    output: succeeded ? new Blob(["jpeg"], { type: "image/jpeg" }) : null,
    outputFormat: succeeded ? "jpeg" : null,
    outputName: null,
    subjectExists: succeeded,
    targetTagCount: succeeded ? 1 : 0,
    reencoded: false,
    message: state,
    elapsedMs: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class TrackingClient implements WorkerClientLike {
  readonly started: ProcessRequest[] = [];
  readonly pending = new Map<string, ReturnType<typeof deferred<ProcessResult>>>();
  cancelCount = 0;
  disposeCount = 0;
  active = 0;
  maximum = 0;

  process(payload: ProcessRequest): Promise<ProcessResult> {
    this.started.push(payload);
    this.active += 1;
    this.maximum = Math.max(this.maximum, this.active);
    const operation = deferred<ProcessResult>();
    this.pending.set(payload.id, operation);
    return operation.promise.finally(() => {
      this.active -= 1;
      this.pending.delete(payload.id);
    });
  }

  cancelAll(): void {
    this.cancelCount += 1;
    for (const operation of this.pending.values()) {
      operation.reject(new ProcessingError("CANCELLED", "cancelled"));
    }
  }

  dispose(): void {
    this.disposeCount += 1;
    for (const operation of this.pending.values()) {
      operation.reject(new ProcessingError("CANCELLED", "disposed"));
    }
  }

  finish(id: string, state: ProcessResult["state"] = "checked"): void {
    this.pending.get(id)?.resolve(result(id, state));
  }

  fail(id: string, reason: unknown = new Error("/private/user/path leaked")): void {
    this.pending.get(id)?.reject(reason);
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("BatchRunner", () => {
  it("uses one conversion lane, two metadata lanes, and preserves input order", async () => {
    const conversion = new TrackingClient();
    const metadataA = new TrackingClient();
    const metadataB = new TrackingClient();
    const runner = new BatchRunner({
      conversionClients: [conversion],
      metadataClients: [metadataA, metadataB],
    });
    const requests = [
      request("convert-png", "png", "jpeg-and-xmp"),
      request("meta-jpeg", "jpeg", "jpeg-and-xmp"),
      request("convert-webp", "webp", "jpeg-and-xmp"),
      request("meta-png", "png", "original-and-xmp"),
      request("verify-bmp", "bmp", "verify-only"),
      request("convert-bmp", "bmp", "jpeg-and-xmp"),
    ];

    const running = runner.run(requests, () => undefined);
    await flush();

    expect(conversion.started.map(({ id }) => id)).toEqual(["convert-png"]);
    expect([
      ...metadataA.started.map(({ id }) => id),
      ...metadataB.started.map(({ id }) => id),
    ].sort()).toEqual(["meta-jpeg", "meta-png"].sort());
    expect(conversion.maximum).toBe(1);
    expect(metadataA.maximum).toBe(1);
    expect(metadataB.maximum).toBe(1);

    const firstMetadataClient = metadataA.started.some(({ id }) => id === "meta-jpeg")
      ? metadataA
      : metadataB;
    firstMetadataClient.finish("meta-jpeg");
    await flush();
    expect([
      ...metadataA.started.map(({ id }) => id),
      ...metadataB.started.map(({ id }) => id),
    ].sort()).toEqual(["meta-jpeg", "meta-png", "verify-bmp"].sort());
    metadataA.started.forEach(({ id }) => metadataA.finish(id));
    metadataB.started.forEach(({ id }) => metadataB.finish(id));
    conversion.finish("convert-png", "success");
    await flush();
    expect(conversion.started.map(({ id }) => id)).toEqual([
      "convert-png",
      "convert-webp",
    ]);
    conversion.finish("convert-webp", "success");
    await flush();
    conversion.finish("convert-bmp", "success");

    const output = await running;
    expect(output.map(({ id }) => id)).toEqual(requests.map(({ id }) => id));
  });

  it("contains one rejection as a safe failed result and continues its lane", async () => {
    const client = new TrackingClient();
    const runner = new BatchRunner({
      conversionClients: [new TrackingClient()],
      metadataClients: [client],
    });
    const running = runner.run(
      [request("bad"), request("good")],
      () => undefined,
    );
    await flush();
    client.fail("bad");
    await flush();
    expect(client.started.map(({ id }) => id)).toEqual(["bad", "good"]);
    client.finish("good");

    const [bad, good] = await running;
    expect(bad).toMatchObject({
      id: "bad",
      state: "failed",
      output: null,
      message: "处理失败，请重试。",
    });
    expect(bad!.message).not.toContain("path");
    expect(good!.state).toBe("checked");
  });

  it("cancels queued and in-flight items exactly once and can run again", async () => {
    const conversion = new TrackingClient();
    const metadata = new TrackingClient();
    const runner = new BatchRunner({
      conversionClients: [conversion],
      metadataClients: [metadata],
    });
    const progress: BatchProgress[] = [];
    const running = runner.run(
      [
        request("a", "png", "jpeg-and-xmp"),
        request("b", "webp", "jpeg-and-xmp"),
        request("c"),
        request("d"),
      ],
      (value) => progress.push(value),
    );
    await flush();
    runner.cancel();
    const cancelled = await running;

    expect(cancelled).toHaveLength(4);
    expect(cancelled.every(({ state }) => state === "cancelled")).toBe(true);
    expect(conversion.started.map(({ id }) => id)).toEqual(["a"]);
    expect(metadata.started.map(({ id }) => id)).toEqual(["c"]);
    expect(conversion.cancelCount).toBe(1);
    expect(metadata.cancelCount).toBe(1);
    expect(progress).toHaveLength(5);

    const second = runner.run([request("again")], () => undefined);
    await flush();
    metadata.finish("again");
    await expect(second).resolves.toMatchObject([{ id: "again", state: "checked" }]);
  });

  it("disposes active lanes without creating replacement workers", async () => {
    const conversion = new TrackingClient();
    const metadata = new TrackingClient();
    const runner = new BatchRunner({
      conversionClients: [conversion],
      metadataClients: [metadata],
    });
    const running = runner.run(
      [
        request("convert", "png", "jpeg-and-xmp"),
        request("metadata"),
        request("queued"),
      ],
      () => undefined,
    );
    await flush();

    runner.dispose();

    await expect(running).resolves.toSatisfy((results: ProcessResult[]) =>
      results.every(({ state }) => state === "cancelled"),
    );
    expect(conversion.disposeCount).toBe(1);
    expect(metadata.disposeCount).toBe(1);
    expect(conversion.cancelCount).toBe(0);
    expect(metadata.cancelCount).toBe(0);
    await expect(
      runner.run([request("after-dispose")], () => undefined),
    ).rejects.toMatchObject({ code: "INVALID_MODE" });
  });

  it("emits exact progress invariants initially and once per completed item", async () => {
    const client = new TrackingClient();
    const runner = new BatchRunner({
      conversionClients: [new TrackingClient()],
      metadataClients: [client],
    });
    const updates: BatchProgress[] = [];
    const running = runner.run(
      [request("one"), request("two"), request("three")],
      (progress) => updates.push(progress),
    );
    await flush();
    client.finish("one", "success");
    await flush();
    client.finish("two", "checked");
    await flush();
    client.finish("three", "failed");
    await running;

    expect(updates).toHaveLength(4);
    expect(updates[0]).toEqual({
      total: 3,
      completed: 0,
      success: 0,
      checked: 0,
      failed: 0,
      cancelled: 0,
      current: null,
    });
    for (const [index, update] of updates.entries()) {
      expect(update.completed).toBe(index);
      expect(
        update.success + update.checked + update.failed + update.cancelled,
      ).toBe(update.completed);
      expect(update.completed).toBeLessThanOrEqual(update.total);
    }
    expect(updates.at(-1)).toMatchObject({
      completed: 3,
      success: 1,
      checked: 1,
      failed: 1,
      cancelled: 0,
      current: { id: "three" },
    });
  });

  it("handles an empty batch and rejects overlapping runs without corrupting the first", async () => {
    const client = new TrackingClient();
    const runner = new BatchRunner({
      conversionClients: [new TrackingClient()],
      metadataClients: [client],
    });
    const emptyProgress = vi.fn();
    await expect(runner.run([], emptyProgress)).resolves.toEqual([]);
    expect(emptyProgress).toHaveBeenCalledOnce();

    const first = runner.run([request("active")], () => undefined);
    await expect(
      runner.run([request("overlap")], () => undefined),
    ).rejects.toMatchObject({
      name: "ProcessingError",
      code: "INVALID_MODE",
      message: expect.stringContaining("批次"),
    });
    await flush();
    client.finish("active");
    await expect(first).resolves.toMatchObject([{ id: "active" }]);
  });

  it("lets cancellation win a pending result race and never emits after settling", async () => {
    const client = new TrackingClient();
    const runner = new BatchRunner({
      conversionClients: [new TrackingClient()],
      metadataClients: [client],
    });
    const updates: BatchProgress[] = [];
    const running = runner.run([request("race")], (value) => updates.push(value));
    await flush();
    client.finish("race", "success");
    runner.cancel();
    const output = await running;
    expect(output[0]?.state).toBe("cancelled");
    const count = updates.length;
    await flush();
    expect(updates).toHaveLength(count);
  });

  it("contains a malformed injected client result without corrupting progress counts", async () => {
    const malformedClient: WorkerClientLike = {
      process: async (payload) =>
        ({
          ...result(payload.id),
          state: "surprise",
          elapsedMs: Number.NaN,
        }) as unknown as ProcessResult,
      cancelAll: () => undefined,
    };
    const updates: BatchProgress[] = [];
    const runner = new BatchRunner({
      conversionClients: [new TrackingClient()],
      metadataClients: [malformedClient],
    });

    const output = await runner.run(
      [request("unsafe")],
      (progress) => updates.push(progress),
    );

    expect(output).toMatchObject([
      {
        id: "unsafe",
        state: "failed",
        message: "处理失败，请重试。",
      },
    ]);
    expect(updates.at(-1)).toMatchObject({
      total: 1,
      completed: 1,
      success: 0,
      checked: 0,
      failed: 1,
      cancelled: 0,
    });
    expect(
      updates.every(
        (progress) =>
          progress.completed ===
          progress.success +
            progress.checked +
            progress.failed +
            progress.cancelled,
      ),
    ).toBe(true);
  });

  it("isolates stored results and later progress from a mutating callback", async () => {
    const client = new TrackingClient();
    const runner = new BatchRunner({
      conversionClients: [new TrackingClient()],
      metadataClients: [client],
    });
    const observed: BatchProgress[] = [];
    const running = runner.run(
      [request("first-safe"), request("second-safe")],
      (progress) => {
        observed.push({
          ...progress,
          current:
            progress.current === null ? null : { ...progress.current },
        });
        progress.completed = 999;
        progress.success = 999;
        if (progress.current !== null) {
          progress.current.state = "cancelled";
          progress.current.message = "mutated by callback";
          progress.current.elapsedMs = Number.NaN;
        }
      },
    );
    await flush();
    client.finish("first-safe", "success");
    await flush();
    client.finish("second-safe", "checked");

    const output = await running;
    expect(output).toMatchObject([
      {
        id: "first-safe",
        state: "success",
        message: "success",
        elapsedMs: 1,
      },
      {
        id: "second-safe",
        state: "checked",
        message: "checked",
        elapsedMs: 1,
      },
    ]);
    expect(observed.at(-1)).toMatchObject({
      total: 2,
      completed: 2,
      success: 1,
      checked: 1,
      failed: 0,
      cancelled: 0,
      current: { id: "second-safe", state: "checked" },
    });
  });
});

type EventHandler = (event: MessageEvent | ErrorEvent) => void;

class FakeWorker implements WorkerLike {
  readonly listeners = new Map<string, Set<EventHandler>>();
  readonly posted: unknown[] = [];
  terminated = false;

  addEventListener(type: string, handler: EventHandler): void {
    const handlers = this.listeners.get(type) ?? new Set<EventHandler>();
    handlers.add(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type: string, handler: EventHandler): void {
    this.listeners.get(type)?.delete(handler);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(type: "message" | "messageerror" | "error", data?: unknown): void {
    const event =
      type === "message"
        ? new MessageEvent("message", { data })
        : type === "error"
          ? new ErrorEvent("error", { message: String(data ?? "") })
          : new MessageEvent("messageerror", { data });
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event);
    }
  }
}

describe("WorkerClient", () => {
  it("correlates concurrent requests and posts Files without transfer lists", async () => {
    const workers: FakeWorker[] = [];
    const client = new WorkerClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const firstRequest = request("first");
    const secondRequest = request("second");
    const first = client.process(firstRequest);
    const second = client.process(secondRequest);
    const worker = workers[0]!;

    expect(worker.listeners.get("message")?.size).toBe(1);
    expect(worker.listeners.get("error")?.size).toBe(1);
    expect(worker.listeners.get("messageerror")?.size).toBe(1);
    expect(worker.posted).toHaveLength(2);
    expect((worker.posted[0] as { payload: ProcessRequest }).payload.file)
      .toBe(firstRequest.file);
    const firstId = (worker.posted[0] as { requestId: string }).requestId;
    const secondId = (worker.posted[1] as { requestId: string }).requestId;
    worker.emit("message", {
      type: "result",
      requestId: secondId,
      payload: result("second"),
    });
    worker.emit("message", {
      type: "result",
      requestId: firstId,
      payload: result("first"),
    });

    await expect(first).resolves.toMatchObject({ id: "first" });
    await expect(second).resolves.toMatchObject({ id: "second" });
  });

  it("pings for readiness, cancels all, replaces its generation, and ignores stale messages", async () => {
    const workers: FakeWorker[] = [];
    const client = new WorkerClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const ready = client.ping();
    const firstWorker = workers[0]!;
    const pingId = (firstWorker.posted[0] as { requestId: string }).requestId;
    firstWorker.emit("message", { type: "pong", requestId: pingId });
    await expect(ready).resolves.toBeUndefined();

    const pending = client.process(request("cancel-me"));
    const staleId = (firstWorker.posted.at(-1) as { requestId: string }).requestId;
    client.cancelAll();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(firstWorker.terminated).toBe(true);
    expect(firstWorker.listeners.get("message")?.size).toBe(0);
    expect(firstWorker.listeners.get("error")?.size).toBe(0);
    expect(firstWorker.listeners.get("messageerror")?.size).toBe(0);
    expect(workers).toHaveLength(2);

    const later = client.process(request("later"));
    firstWorker.emit("message", {
      type: "result",
      requestId: staleId,
      payload: result("wrong"),
    });
    const secondWorker = workers[1]!;
    const laterId = (secondWorker.posted[0] as { requestId: string }).requestId;
    secondWorker.emit("message", {
      type: "result",
      requestId: laterId,
      payload: result("later"),
    });
    await expect(later).resolves.toMatchObject({ id: "later" });
    expect(secondWorker.listeners.get("message")?.size).toBe(1);
  });

  it("disposes pending work without eagerly creating a replacement", async () => {
    const workers: FakeWorker[] = [];
    const client = new WorkerClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const pending = client.process(request("dispose-me"));
    const worker = workers[0]!;

    client.dispose();

    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(worker.terminated).toBe(true);
    expect(worker.listeners.get("message")?.size).toBe(0);
    expect(workers).toHaveLength(1);
    await expect(client.process(request("after-dispose"))).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(workers).toHaveLength(1);
  });

  it("contains constructor, runtime, message, and postMessage failures safely", async () => {
    const constructorClient = new WorkerClient(() => {
      throw new Error("/secret/constructor path");
    });
    await expect(constructorClient.ping()).rejects.toMatchObject({
      code: "CORRUPT_CONTAINER",
      message: "后台处理器启动失败，请重试。",
    });

    const worker = new FakeWorker();
    const runtimeClient = new WorkerClient(() => worker);
    const pending = runtimeClient.process(request("crash"));
    worker.emit("error", "/secret/runtime path");
    await expect(pending).rejects.toMatchObject({
      code: "CORRUPT_CONTAINER",
      message: "后台处理器意外停止，请重试。",
    });
    expect(worker.terminated).toBe(true);

    const replacement = new FakeWorker();
    const messageClient = new WorkerClient(() => replacement);
    const malformed = messageClient.process(request("bad-message"));
    replacement.emit("message", { nope: true });
    await expect(malformed).rejects.toMatchObject({
      code: "CORRUPT_CONTAINER",
    });
  });

  it("accepts the exact nested error response shape", async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient(() => worker);
    const pending = client.process(request("known-error"));
    const requestId = (worker.posted[0] as { requestId: string }).requestId;
    worker.emit("message", {
      type: "error",
      requestId,
      error: {
        code: "LIMIT_EXCEEDED",
        message: "图片超过安全处理上限。",
      },
    });
    await expect(pending).rejects.toMatchObject({
      name: "ProcessingError",
      code: "LIMIT_EXCEEDED",
      message: "图片超过安全处理上限。",
    });
  });

  it.each([
    ["missing fields", { id: "malformed", state: "success" }],
    ["unknown state", { ...result("malformed"), state: "surprise" }],
    ["wrong payload id", result("someone-else")],
    ["negative elapsed time", { ...result("malformed"), elapsedMs: -1 }],
    ["NaN target count", { ...result("malformed"), targetTagCount: Number.NaN }],
    [
      "incoherent checked output",
      {
        ...result("malformed"),
        output: new Blob(["unexpected"]),
        outputFormat: "jpeg",
      },
    ],
  ])("rejects a correlated malformed result: %s", async (_label, payload) => {
    const worker = new FakeWorker();
    const client = new WorkerClient(() => worker);
    const pending = client.process(request("malformed"));
    const requestId = (worker.posted[0] as { requestId: string }).requestId;
    worker.emit("message", {
      type: "result",
      requestId,
      payload,
    });
    await expect(pending).rejects.toMatchObject({
      name: "ProcessingError",
      code: "CORRUPT_CONTAINER",
      message: "后台处理器意外停止，请重试。",
    });
  });
});
