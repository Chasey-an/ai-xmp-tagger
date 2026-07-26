import { describe, expect, it, vi } from "vitest";

import type {
  ProcessRequest,
  ProcessResult,
} from "../../src/core/process-file";
import { handleWorkerMessage } from "../../src/worker/process.worker";
import type { WorkerResponse } from "../../src/worker/protocol";

function validRequest(): ProcessRequest {
  return {
    id: "valid-id",
    file: new File(["jpeg"], "image.jpg", { type: "image/jpeg" }),
    format: "jpeg",
    relativePath: "folder/image.jpg",
    mode: "verify-only",
  };
}

function checkedResult(): ProcessResult {
  return {
    id: "valid-id",
    state: "checked",
    output: null,
    outputFormat: null,
    outputName: null,
    subjectExists: false,
    targetTagCount: 0,
    reencoded: false,
    message: "checked",
    elapsedMs: 1,
  };
}

function oversizedFile(): File {
  const source = new File(["jpeg"], "large.jpg");
  return new Proxy(source, {
    get(target, property) {
      if (property === "size") {
        return 50 * 1024 * 1024 + 1;
      }
      return Reflect.get(target, property, target) as unknown;
    },
  });
}

describe("process worker inbound validation", () => {
  it("accepts the exact process request and preserves correlation", async () => {
    const process = vi.fn(async () => checkedResult());
    const responses: WorkerResponse[] = [];
    await handleWorkerMessage(
      {
        type: "process",
        requestId: "worker-1",
        payload: validRequest(),
      },
      (response) => responses.push(response),
      process,
    );

    expect(process).toHaveBeenCalledOnce();
    expect(process).toHaveBeenCalledWith(
      expect.objectContaining({ id: "valid-id", file: expect.any(File) }),
    );
    expect(responses).toEqual([
      {
        type: "result",
        requestId: "worker-1",
        payload: checkedResult(),
      },
    ]);
  });

  it("accepts an exact ping without invoking image processing", async () => {
    const process = vi.fn(async () => checkedResult());
    const responses: WorkerResponse[] = [];
    await handleWorkerMessage(
      { type: "ping", requestId: "ready-1" },
      (response) => responses.push(response),
      process,
    );
    expect(process).not.toHaveBeenCalled();
    expect(responses).toEqual([
      { type: "pong", requestId: "ready-1" },
    ]);
  });

  it.each([
    ["missing payload", undefined],
    ["payload is null", null],
    ["payload is not an object", "bad"],
    ["missing id", { ...validRequest(), id: undefined }],
    ["empty id", { ...validRequest(), id: "" }],
    ["oversized id", { ...validRequest(), id: "x".repeat(257) }],
    ["blob is not a File", { ...validRequest(), file: new Blob(["jpeg"]) }],
    ["empty File", { ...validRequest(), file: new File([], "empty.jpg") }],
    [
      "oversized File",
      {
        ...validRequest(),
        file: oversizedFile(),
      },
    ],
    ["unsupported format", { ...validRequest(), format: "gif" }],
    ["unsupported mode", { ...validRequest(), mode: "rewrite-all" }],
    ["missing relative path", { ...validRequest(), relativePath: undefined }],
    ["absolute relative path", { ...validRequest(), relativePath: "/image.jpg" }],
    ["parent traversal", { ...validRequest(), relativePath: "../image.jpg" }],
    ["NUL path", { ...validRequest(), relativePath: "folder/\0image.jpg" }],
    [
      "oversized path",
      { ...validRequest(), relativePath: `${"a".repeat(4097)}.jpg` },
    ],
    ["extra payload field", { ...validRequest(), unexpected: true }],
  ])("rejects a malformed correlated process request: %s", async (_label, payload) => {
    const process = vi.fn(async () => checkedResult());
    const responses: WorkerResponse[] = [];
    await handleWorkerMessage(
      {
        type: "process",
        requestId: "correlated-1",
        ...(payload === undefined ? {} : { payload }),
      },
      (response) => responses.push(response),
      process,
    );

    expect(process).not.toHaveBeenCalled();
    expect(responses).toEqual([
      {
        type: "error",
        requestId: "correlated-1",
        error: {
          code: "CORRUPT_CONTAINER",
          message: "后台请求无效，请重试。",
        },
      },
    ]);
  });

  it.each([
    ["unknown type", { type: "other", requestId: "known-1" }],
    ["ping with extra data", { type: "ping", requestId: "known-1", extra: true }],
    ["empty request id", { type: "ping", requestId: "" }],
    ["oversized request id", { type: "ping", requestId: "x".repeat(257) }],
  ])("contains malformed envelopes: %s", async (_label, input) => {
    const process = vi.fn(async () => checkedResult());
    const responses: WorkerResponse[] = [];
    await handleWorkerMessage(
      input,
      (response) => responses.push(response),
      process,
    );

    expect(process).not.toHaveBeenCalled();
    if (input.requestId.length > 0 && input.requestId.length <= 256) {
      expect(responses).toEqual([
        {
          type: "error",
          requestId: input.requestId,
          error: {
            code: "CORRUPT_CONTAINER",
            message: "后台请求无效，请重试。",
          },
        },
      ]);
    } else {
      expect(responses).toEqual([]);
    }
  });

  it("contains a throwing malformed payload and returns a correlated safe error", async () => {
    const process = vi.fn(async () => checkedResult());
    const responses: WorkerResponse[] = [];
    const hostilePayload = new Proxy(validRequest(), {
      ownKeys() {
        throw new Error("/private/path must not escape");
      },
    });

    await expect(
      handleWorkerMessage(
        {
          type: "process",
          requestId: "hostile-1",
          payload: hostilePayload,
        },
        (response) => responses.push(response),
        process,
      ),
    ).resolves.toBeUndefined();
    expect(process).not.toHaveBeenCalled();
    expect(responses).toEqual([
      {
        type: "error",
        requestId: "hostile-1",
        error: {
          code: "CORRUPT_CONTAINER",
          message: "后台请求无效，请重试。",
        },
      },
    ]);
  });
});
