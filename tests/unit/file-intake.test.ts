// @vitest-environment node

import { File as HappyDOMFile } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_BATCH_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
} from "../../src/core/constants";
import { ProcessingError } from "../../src/core/errors";
import {
  applyBatchPolicy,
  inspectSelectedFile,
  mergeSelectedImages,
  type SelectedImage,
} from "../../src/core/file-intake";

interface FakeFileOptions {
  lastModified?: number;
  size?: number;
  type?: string;
  webkitRelativePath?: string;
}

function fakeFile(
  bytes: readonly number[],
  name: string,
  options: FakeFileOptions = {},
): File {
  const source = Uint8Array.from(bytes);
  return {
    name,
    size: options.size ?? source.byteLength,
    lastModified: options.lastModified ?? 1_700_000_000_000,
    type: options.type ?? "",
    webkitRelativePath: options.webkitRelativePath ?? "",
    slice(start?: number, end?: number) {
      const part = source.slice(start, end);
      return {
        arrayBuffer: async () =>
          part.buffer.slice(
            part.byteOffset,
            part.byteOffset + part.byteLength,
          ) as ArrayBuffer,
      };
    },
  } as unknown as File;
}

function selected(
  id: string,
  name = `${id}.png`,
  size = 1,
  lastModified = 1,
  relativePath = name,
): SelectedImage {
  return {
    id,
    file: fakeFile([], name, { size, lastModified }),
    format: "png",
    relativePath,
    warning: null,
  };
}

async function expectProcessingError(
  operation: () => Promise<unknown> | unknown,
  code: ProcessingError["code"],
): Promise<void> {
  try {
    await operation();
    throw new Error("Expected operation to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ProcessingError);
    expect(error).toMatchObject({ name: "ProcessingError", code });
  }
}

describe("local image file intake", () => {
  it("detects PNG magic in a wrongly named JPG and warns about the extension", async () => {
    const image = await inspectSelectedFile(
      fakeFile([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "wrong.jpg"),
      "wrong.jpg",
    );

    expect(image.format).toBe("png");
    expect(image.warning).toBe("扩展名与文件内容不一致");
  });

  it("uses magic instead of MIME and accepts uppercase matching extensions", async () => {
    const image = await inspectSelectedFile(
      fakeFile([0xff, 0xd8, 0xff, 0xe0], "PHOTO.JPEG", {
        type: "image/png",
      }),
      "PHOTO.JPEG",
    );

    expect(image.format).toBe("jpeg");
    expect(image.warning).toBeNull();
  });

  it.each([
    ["jpeg", [0xff, 0xd8, 0xff], "photo.jpg"],
    ["png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "photo.png"],
    ["webp", [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], "photo.webp"],
    ["bmp", [0x42, 0x4d], "photo.bmp"],
  ] as const)("detects %s from magic bytes", async (format, bytes, name) => {
    await expect(
      inspectSelectedFile(fakeFile(bytes, name), name),
    ).resolves.toMatchObject({ format, warning: null });
  });

  it("rejects too-short, unsupported, and zero-byte files", async () => {
    await expectProcessingError(
      () => inspectSelectedFile(fakeFile([0xff, 0xd8], "short.jpg"), "short.jpg"),
      "UNSUPPORTED_FORMAT",
    );
    await expectProcessingError(
      () => inspectSelectedFile(fakeFile([1, 2, 3, 4], "unknown.bin"), "unknown.bin"),
      "UNSUPPORTED_FORMAT",
    );
    await expectProcessingError(
      () => inspectSelectedFile(fakeFile([], "empty.png"), "empty.png"),
      "UNSUPPORTED_FORMAT",
    );
  });

  it("reads at most 32 header bytes and rejects oversized files before slicing", async () => {
    const calls: Array<[number | undefined, number | undefined]> = [];
    const sliced = fakeFile([0xff, 0xd8, 0xff, ...Array(64).fill(0)], "read.jpg");
    const originalSlice = sliced.slice.bind(sliced);
    sliced.slice = ((start?: number, end?: number) => {
      calls.push([start, end]);
      return originalSlice(start, end);
    }) as File["slice"];

    await inspectSelectedFile(sliced, "read.jpg");
    expect(calls).toEqual([[0, 32]]);

    let oversizedSliceCalls = 0;
    const oversized = fakeFile([], "huge.png", { size: MAX_FILE_BYTES + 1 });
    oversized.slice = (() => {
      oversizedSliceCalls += 1;
      throw new Error("slice must not be called");
    }) as File["slice"];

    await expectProcessingError(
      () => inspectSelectedFile(oversized, "huge.png"),
      "LIMIT_EXCEEDED",
    );
    expect(oversizedSliceCalls).toBe(0);
  });

  it("wraps rejected header reads as a stable corrupt-container error", async () => {
    const readFailure = new Error("storage read failed");
    const unreadable = fakeFile([0x42, 0x4d], "unreadable.bmp");
    unreadable.slice = (() => ({
      arrayBuffer: async () => Promise.reject(readFailure),
    })) as File["slice"];

    try {
      await inspectSelectedFile(unreadable, "unreadable.bmp");
      throw new Error("Expected operation to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProcessingError);
      expect(error).toMatchObject({
        code: "CORRUPT_CONTAINER",
        cause: readFailure,
        message: expect.stringMatching(/读取.*失败/),
      });
    }
  });

  it("also wraps a synchronous slice failure and preserves its cause", async () => {
    const sliceFailure = new Error("slice failed");
    const unreadable = fakeFile([0x42, 0x4d], "unreadable.bmp");
    unreadable.slice = (() => {
      throw sliceFailure;
    }) as File["slice"];

    await expect(inspectSelectedFile(unreadable, "unreadable.bmp")).rejects.toMatchObject({
      name: "ProcessingError",
      code: "CORRUPT_CONTAINER",
      cause: sliceFailure,
    });
  });

  it("detects magic through a real happy-dom File Blob slice", async () => {
    const file = new HappyDOMFile(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      "real.PNG",
      { type: "image/jpeg" },
    );

    await expect(
      inspectSelectedFile(file as unknown as File, "real.PNG"),
    ).resolves.toMatchObject({ format: "png", warning: null });
  });

  it("uses and normalizes supplied and browser relative paths without renaming", async () => {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    await expect(
      inspectSelectedFile(fakeFile(png, "原图.PNG"), ".\\相册\\旅行\\原图.PNG"),
    ).resolves.toMatchObject({ relativePath: "相册/旅行/原图.PNG" });
    await expect(
      inspectSelectedFile(
        fakeFile(png, "原图.PNG", {
          webkitRelativePath: "文件夹\\嵌套\\原图.PNG",
        }),
        "",
      ),
    ).resolves.toMatchObject({ relativePath: "文件夹/嵌套/原图.PNG" });
    await expect(
      inspectSelectedFile(fakeFile(png, "原图.PNG"), ""),
    ).resolves.toMatchObject({ relativePath: "原图.PNG" });
    await expect(
      inspectSelectedFile(
        fakeFile(png, "原图.PNG", {
          webkitRelativePath: "浏览器提供的路径/原图.PNG",
        }),
        "调用方/指定/原图.PNG",
      ),
    ).resolves.toMatchObject({ relativePath: "调用方/指定/原图.PNG" });
    await expect(
      inspectSelectedFile(fakeFile(png, "原图.PNG"), "./././相册/原图.PNG"),
    ).resolves.toMatchObject({ relativePath: "相册/原图.PNG" });
    await expect(
      inspectSelectedFile(fakeFile(png, "原图.PNG"), "././"),
    ).resolves.toMatchObject({ relativePath: "原图.PNG" });
    await expect(
      inspectSelectedFile(fakeFile(png, "原图.PNG"), "../外部/原图.PNG"),
    ).resolves.toMatchObject({ relativePath: "../外部/原图.PNG" });
    await expect(
      inspectSelectedFile(fakeFile(png, "原图.PNG"), "/绝对/原图.PNG"),
    ).resolves.toMatchObject({ relativePath: "/绝对/原图.PNG" });
  });

  it("uses crypto.randomUUID when the browser provides it", async () => {
    const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    const randomUUID = vi.fn(() => "browser-generated-id");
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID },
    });

    try {
      const image = await inspectSelectedFile(
        fakeFile([0x42, 0x4d], "photo.bmp"),
        "photo.bmp",
      );

      expect(randomUUID).toHaveBeenCalledOnce();
      expect(image.id).toBe("browser-generated-id");
    } finally {
      if (originalCrypto) {
        Object.defineProperty(globalThis, "crypto", originalCrypto);
      } else {
        Reflect.deleteProperty(globalThis, "crypto");
      }
    }
  });

  it("uses a safe distinct fallback ID when crypto.randomUUID is unavailable", async () => {
    const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: undefined,
    });

    try {
      const first = await inspectSelectedFile(
        fakeFile([0x42, 0x4d], "first.bmp"),
        "/Users/example/absolute/first.bmp",
      );
      const second = await inspectSelectedFile(
        fakeFile([0x42, 0x4d], "second.bmp"),
        "/Users/example/absolute/second.bmp",
      );

      expect(first.id).toMatch(/^local-id-\d+$/);
      expect(second.id).toMatch(/^local-id-\d+$/);
      expect(first.id).not.toBe(second.id);
      const firstSequence = Number(first.id.slice("local-id-".length));
      const secondSequence = Number(second.id.slice("local-id-".length));
      expect(secondSequence).toBe(firstSequence + 1);
      expect(first.id).not.toContain("/Users/example");
      expect(second.id).not.toContain("/Users/example");
    } finally {
      if (originalCrypto) {
        Object.defineProperty(globalThis, "crypto", originalCrypto);
      } else {
        Reflect.deleteProperty(globalThis, "crypto");
      }
    }
  });

  it("merges only exact duplicate identities while preserving first order and inputs", () => {
    const first = selected("first", "same.png", 10, 20, "folder/same.png");
    const duplicate = selected("duplicate", "same.png", 10, 20, "folder/same.png");
    const differentPath = selected("path", "same.png", 10, 20, "other/same.png");
    const differentTime = selected("time", "same.png", 10, 21, "folder/same.png");
    const nulInPath = selected("nul-path", "gamma.png", 10, 20, "folder\0nested");
    const nulInName = selected("nul-name", "nested\0gamma.png", 10, 20, "folder");
    const current = [first];
    const incoming = [duplicate, differentPath, differentTime, nulInPath, nulInName];

    const merged = mergeSelectedImages(current, incoming);

    expect(merged).toEqual([first, differentPath, differentTime, nulInPath, nulInName]);
    expect(current).toEqual([first]);
    expect(incoming).toEqual([
      duplicate,
      differentPath,
      differentTime,
      nulInPath,
      nulInName,
    ]);
    expect(merged).not.toBe(current);
    expect(merged).not.toBe(incoming);
  });

  it("accepts exact file, count, and aggregate batch limits with lightweight files", () => {
    expect(applyBatchPolicy([selected("at-file-limit", "one.png", MAX_FILE_BYTES)])).toMatchObject({
      totalBytes: MAX_FILE_BYTES,
      warning: null,
    });
    expect(
      applyBatchPolicy(Array.from({ length: MAX_FILES }, (_, index) => selected(String(index)))),
    ).toMatchObject({ totalBytes: MAX_FILES, warning: expect.any(String) });
    expect(
      applyBatchPolicy(Array.from({ length: 10 }, (_, index) => selected(String(index), `${index}.png`, MAX_FILE_BYTES))),
    ).toMatchObject({ totalBytes: MAX_BATCH_BYTES, warning: expect.any(String) });
  });

  it("rejects each batch limit when exceeded without allocating payloads", () => {
    expect(() => applyBatchPolicy([selected("too-large", "one.png", MAX_FILE_BYTES + 1)])).toThrow(
      expect.objectContaining({ code: "LIMIT_EXCEEDED" }),
    );
    expect(() =>
      applyBatchPolicy(Array.from({ length: MAX_FILES + 1 }, (_, index) => selected(String(index)))),
    ).toThrow(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
    expect(() =>
      applyBatchPolicy([
        ...Array.from({ length: 10 }, (_, index) => selected(String(index), `${index}.png`, MAX_FILE_BYTES)),
        selected("extra", "extra.png", 1),
      ]),
    ).toThrow(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
  });

  it("warns only above the count and aggregate warning thresholds, including both", () => {
    expect(
      applyBatchPolicy(Array.from({ length: 100 }, (_, index) => selected(String(index)))),
    ).toMatchObject({ warning: null });
    expect(
      applyBatchPolicy(
        Array.from({ length: 5 }, (_, index) =>
          selected(`exact-size-${index}`, `${index}.png`, MAX_FILE_BYTES),
        ),
      ),
    ).toMatchObject({ warning: null });
    expect(
      applyBatchPolicy(Array.from({ length: 101 }, (_, index) => selected(String(index)))),
    ).toMatchObject({ warning: expect.stringMatching(/数量/) });
    expect(
      applyBatchPolicy([
        ...Array.from({ length: 5 }, (_, index) =>
          selected(`above-size-${index}`, `${index}.png`, MAX_FILE_BYTES),
        ),
        selected("above-size-extra", "extra.png", 1),
      ]),
    ).toMatchObject({ warning: expect.stringMatching(/大小/) });
    expect(
      applyBatchPolicy(Array.from({ length: 101 }, (_, index) => selected(String(index), `${index}.png`, 3 * 1024 * 1024))),
    ).toMatchObject({ warning: expect.stringMatching(/数量.*大小/) });
  });

  it("rejects zero-byte entries during batch revalidation", () => {
    expect(() => applyBatchPolicy([selected("empty", "empty.png", 0)])).toThrow(
      expect.objectContaining({ code: "UNSUPPORTED_FORMAT" }),
    );
  });
});
