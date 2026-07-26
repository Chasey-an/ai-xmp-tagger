import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App, type AppDependencies } from "../../src/app/App";
import type { BatchProgress } from "../../src/core/batch-runner";
import type { SelectedImage } from "../../src/core/file-intake";
import type { ProcessRequest, ProcessResult } from "../../src/core/process-file";
import type { ImageFormat } from "../../src/core/types";

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function file(name = "商品图.png", sizeBytes?: number): File {
  const contents =
    sizeBytes === undefined ? PNG_BYTES : new Uint8Array(sizeBytes);
  return new File([contents], name, {
    type: "image/png",
    lastModified: 1_700_000_000_000,
  });
}

function virtualSizeFile(name: string, size: number): File {
  const source = file(name);
  Object.defineProperty(source, "size", {
    configurable: true,
    value: size,
  });
  return source;
}

function selectedImage(
  source: File,
  id = source.name,
  format: ImageFormat = "png",
  relativePath = source.name,
): SelectedImage {
  return {
    id,
    file: source,
    format,
    relativePath,
    warning: null,
  };
}

function processResult(
  id: string,
  overrides: Partial<ProcessResult> = {},
): ProcessResult {
  return {
    id,
    state: "success",
    output: new Blob(["image"], { type: "image/jpeg" }),
    outputFormat: "jpeg",
    outputName: "ignored-from-worker.jpg",
    subjectExists: true,
    targetTagCount: 1,
    reencoded: true,
    message: "处理成功",
    elapsedMs: 12,
    ...overrides,
  };
}

function progress(
  total: number,
  completed: number,
  overrides: Partial<BatchProgress> = {},
): BatchProgress {
  return {
    total,
    completed,
    success: completed,
    checked: 0,
    failed: 0,
    cancelled: 0,
    current: null,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<AppDependencies> = {},
): AppDependencies {
  return {
    inspectFiles: vi.fn(async (files: File[]) =>
      files.map((source, index) =>
        selectedImage(source, `${source.name}-${index}`),
      ),
    ),
    runBatch: vi.fn(async (requests: ProcessRequest[], onProgress) => {
      const results = requests.map((request) => processResult(request.id));
      onProgress(progress(requests.length, requests.length));
      return results;
    }),
    cancelBatch: vi.fn(),
    download: vi.fn(),
    ...overrides,
  };
}

function inputs() {
  return {
    files: screen.getByLabelText("选择图片文件") as HTMLInputElement,
    folder: screen.getByLabelText("选择图片文件夹") as HTMLInputElement,
  };
}

async function addFiles(files: File[], input?: HTMLInputElement) {
  fireEvent.change(input ?? inputs().files, {
    target: { files },
  });
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "开始处理" })).toBeEnabled();
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("browser-local XMP workbench", () => {
  it("shows the exact first-view copy, defaults the JPG mode, and starts disabled", () => {
    render(<App dependencies={dependencies()} />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "批量添加 AI 生成人物 XMP 标签",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("图片只在当前浏览器处理，不会上传服务器"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", {
        name: "转为高清 JPG 并写入标签",
      }),
    ).toBeChecked();
    expect(screen.getByRole("button", { name: "开始处理" })).toBeDisabled();
    expect(document.body.textContent).not.toContain("TIFF");
  });

  it("adds files, deduplicates them, then supports remove and clear", async () => {
    const source = file();
    const inspectFiles = vi.fn(async () => [
      selectedImage(source, "same-id"),
    ]);
    render(<App dependencies={dependencies({ inspectFiles })} />);

    await addFiles([source]);
    fireEvent.change(inputs().files, { target: { files: [source] } });
    await waitFor(() => expect(inspectFiles).toHaveBeenCalledTimes(2));

    expect(screen.getAllByText(source.name)).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: `移除 ${source.name}` }));
    expect(screen.queryByText(source.name)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始处理" })).toBeDisabled();

    await addFiles([file("a.png"), file("b.png")]);
    await userEvent.click(screen.getByRole("button", { name: "清空列表" }));
    expect(screen.queryByText("a.png")).not.toBeInTheDocument();
    expect(screen.queryByText("b.png")).not.toBeInTheDocument();
  });

  it("exposes an accessible folder input with webkitdirectory", () => {
    render(<App dependencies={dependencies()} />);
    const folderInput = inputs().folder;
    expect(folderInput).toHaveAttribute("webkitdirectory");
    expect(folderInput).toHaveAttribute(
      "accept",
      expect.stringContaining(".webp"),
    );
    expect(folderInput).not.toHaveAttribute(
      "accept",
      expect.stringContaining(".tiff"),
    );
  });

  it("activates the drop zone with Enter and Space", () => {
    render(<App dependencies={dependencies()} />);
    const zone = screen.getByRole("button", { name: "添加图片" });
    const imageInput = inputs().files;
    const click = vi.spyOn(imageInput, "click");

    fireEvent.keyDown(zone, { key: "Enter" });
    fireEvent.keyDown(zone, { key: " " });
    expect(click).toHaveBeenCalledTimes(2);
  });

  it("shows soft warnings without blocking and contains hard-limit errors", async () => {
    const inspectFiles = vi.fn(async (sources: File[]) =>
      sources.map((source, index) =>
        selectedImage(source, `${source.name}-${index}`),
      ),
    );
    render(<App dependencies={dependencies({ inspectFiles })} />);

    const warningFiles = Array.from({ length: 101 }, (_, index) =>
      file(`image-${index}.png`),
    );
    fireEvent.change(inputs().files, {
      target: { files: warningFiles },
    });
    expect(
      await screen.findByText(/文件数量超过 100 个/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始处理" })).toBeEnabled();

    fireEvent.change(inputs().files, {
      target: {
        files: Array.from({ length: 501 }, (_, index) =>
          file(`too-many-${index}.png`),
        ),
      },
    });
    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent("无法添加这些图片");
    expect(screen.getAllByText(/image-\d+\.png/)).toHaveLength(101);
  });

  it("warns above 250 MiB and blocks individual or batch byte limits", async () => {
    const inspectFiles = vi.fn(async (sources: File[]) =>
      sources.map((source, index) =>
        selectedImage(source, `${source.name}-${index}`),
      ),
    );
    const view = render(<App dependencies={dependencies({ inspectFiles })} />);

    const softBatch = Array.from({ length: 6 }, (_, index) =>
      virtualSizeFile(`soft-${index}.png`, 45 * 1024 * 1024),
    );
    fireEvent.change(inputs().files, { target: { files: softBatch } });
    expect(
      await screen.findByText(/合计大小超过 250 MiB/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始处理" })).toBeEnabled();

    view.unmount();
    render(<App dependencies={dependencies({ inspectFiles })} />);
    const oversized = virtualSizeFile(
      "oversized.png",
      50 * 1024 * 1024 + 1,
    );
    fireEvent.change(inputs().files, { target: { files: [oversized] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法添加这些图片",
    );
    expect(screen.getByRole("button", { name: "开始处理" })).toBeDisabled();

    cleanup();
    render(<App dependencies={dependencies({ inspectFiles })} />);
    const hugeBatch = Array.from({ length: 11 }, (_, index) =>
      virtualSizeFile(`huge-${index}.png`, 50 * 1024 * 1024),
    );
    fireEvent.change(inputs().files, { target: { files: hugeBatch } });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法添加这些图片",
    );
    expect(screen.getByRole("button", { name: "开始处理" })).toBeDisabled();
  });

  it("locks intake and mode, reports progress, and enters stopping on cancel", async () => {
    let resolveBatch!: (results: ProcessResult[]) => void;
    let reportProgress!: (progress: BatchProgress) => void;
    const runBatch = vi.fn(
      (_requests: ProcessRequest[], onProgress: (value: BatchProgress) => void) =>
        new Promise<ProcessResult[]>((resolve) => {
          reportProgress = onProgress;
          resolveBatch = resolve;
        }),
    );
    const cancelBatch = vi.fn();
    render(<App dependencies={dependencies({ runBatch, cancelBatch })} />);
    await addFiles([file()]);

    await userEvent.click(screen.getByRole("button", { name: "开始处理" }));
    expect(
      screen.getByRole("radio", { name: "保持原格式并写入标签" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "选择图片" })).toBeDisabled();

    reportProgress(progress(1, 0, { current: null }));
    reportProgress(
      progress(1, 1, {
        success: 0,
        failed: 1,
        current: processResult("商品图.png-0", {
          state: "failed",
          output: null,
          outputFormat: null,
        }),
      }),
    );
    expect(await screen.findByText(/已完成 1 \/ 1/)).toBeInTheDocument();
    expect(screen.getByText(/失败 1/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "取消处理" }));
    expect(cancelBatch).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "正在停止…" }),
    ).toBeDisabled();
    resolveBatch([
      processResult("商品图.png-0", {
        state: "cancelled",
        output: null,
        outputFormat: null,
      }),
    ]);
  });

  it("builds requests with the selected mode and focuses completed results", async () => {
    const source = file("keep.png");
    const runBatch = vi.fn(async (requests: ProcessRequest[]) =>
      requests.map((request) => processResult(request.id)),
    );
    render(<App dependencies={dependencies({ runBatch })} />);
    await addFiles([source]);
    await userEvent.click(
      screen.getByRole("radio", { name: "保持原格式并写入标签" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "开始处理" }));

    await waitFor(() => expect(runBatch).toHaveBeenCalled());
    expect(runBatch.mock.calls[0]?.[0]).toMatchObject([
      { mode: "original-and-xmp", relativePath: "keep.png" },
    ]);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "处理结果" })).toHaveFocus(),
    );
  });

  it("keeps the completed batch mode accurate if the next mode is selected", async () => {
    render(<App dependencies={dependencies()} />);
    await addFiles([file()]);
    await userEvent.click(screen.getByRole("button", { name: "开始处理" }));
    expect(
      await screen.findByRole("cell", {
        name: "转为高清 JPG 并写入",
      }),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("radio", { name: "只检查 XMP 标签" }),
    );
    expect(
      screen.getByRole("cell", {
        name: "转为高清 JPG 并写入",
      }),
    ).toBeInTheDocument();
  });

  it("warns about BMP in original and verify modes without disabling the batch", async () => {
    const bmp = file("source.bmp");
    const inspectFiles = vi.fn(async () => [
      selectedImage(bmp, "bmp-id", "bmp"),
    ]);
    render(<App dependencies={dependencies({ inspectFiles })} />);
    await addFiles([bmp]);
    await userEvent.click(
      screen.getByRole("radio", { name: "保持原格式并写入标签" }),
    );

    expect(screen.getByText(/BMP 在此模式下会逐个显示为不支持/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始处理" })).toBeEnabled();
  });

  it("offers a direct image and separate CSV for one successful output", async () => {
    const download = vi.fn();
    render(<App dependencies={dependencies({ download })} />);
    await addFiles([file("one.png")]);
    await userEvent.click(screen.getByRole("button", { name: "开始处理" }));

    await userEvent.click(
      await screen.findByRole("button", { name: "下载处理后的图片" }),
    );
    expect(download).toHaveBeenCalledWith(
      expect.any(Blob),
      "one_xmp.jpg",
    );
    await userEvent.click(screen.getByRole("button", { name: "下载 CSV 报告" }));
    expect(download).toHaveBeenLastCalledWith(
      expect.any(Blob),
      "processing-report.csv",
    );
  });

  it("offers ZIP plus CSV for partial success and does not mutate worker results", async () => {
    const first = processResult("first-id");
    const second = processResult("second-id", {
      output: new Blob(["two"], { type: "image/png" }),
      outputFormat: "png",
      outputName: "wrong.jpg",
      reencoded: false,
    });
    const failed = processResult("failed-id", {
      state: "failed",
      output: null,
      outputFormat: null,
      outputName: null,
      targetTagCount: 0,
      message: "文件损坏",
    });
    const snapshots = [first, second, failed].map((result) => ({ ...result }));
    const inspectFiles = vi.fn(async (sources: File[]) => [
      selectedImage(sources[0]!, "first-id", "png", "目录/a.png"),
      selectedImage(sources[1]!, "second-id", "png", "目录/b.png"),
      selectedImage(sources[2]!, "failed-id", "png", "目录/c.png"),
    ]);
    const runBatch = vi.fn(async () => [first, second, failed]);
    const download = vi.fn();
    render(
      <App
        dependencies={dependencies({ inspectFiles, runBatch, download })}
      />,
    );
    await addFiles([file("a.png"), file("b.png"), file("c.png")]);
    await userEvent.click(screen.getByRole("button", { name: "开始处理" }));

    expect(await screen.findByText("文件损坏")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "下载 2 个成功文件（ZIP）" }),
    );
    await waitFor(() =>
      expect(download).toHaveBeenCalledWith(
        expect.any(Blob),
        expect.stringMatching(/^AI_XMP_Output_\d{8}-\d{4}\.zip$/),
      ),
    );
    expect([first, second, failed]).toEqual(snapshots);
    await userEvent.click(screen.getByRole("button", { name: "下载 CSV 报告" }));
    expect(download).toHaveBeenCalledTimes(2);
  });

  it("offers only CSV after verify-only results", async () => {
    const runBatch = vi.fn(async (requests: ProcessRequest[]) =>
      requests.map((request) =>
        processResult(request.id, {
          state: "checked",
          output: null,
          outputFormat: null,
          outputName: null,
          reencoded: false,
        }),
      ),
    );
    render(<App dependencies={dependencies({ runBatch })} />);
    await addFiles([file()]);
    await userEvent.click(
      screen.getByRole("radio", { name: "只检查 XMP 标签" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "开始处理" }));

    expect(
      await screen.findByRole("button", { name: "下载 CSV 报告" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: /下载.*(?:图片|ZIP)/ }),
    ).not.toBeInTheDocument();
  });

  it("disables duplicate ZIP clicks while packaging", async () => {
    let release!: () => Promise<void>;
    class DelayedBlob extends Blob {
      override stream(): ReturnType<Blob["stream"]> {
        const bytes = this.arrayBuffer();
        return new ReadableStream<Uint8Array<ArrayBuffer>>({
          start(controller) {
            release = async () => {
              controller.enqueue(new Uint8Array(await bytes));
              controller.close();
            };
          },
        });
      }
    }
    const runBatch = vi.fn(async (requests: ProcessRequest[]) =>
      requests.map((request, index) =>
        processResult(request.id, {
          output:
            index === 0
              ? new DelayedBlob(["delayed"], { type: "image/jpeg" })
              : new Blob(["ready"], { type: "image/jpeg" }),
        }),
      ),
    );
    const download = vi.fn();
    render(<App dependencies={dependencies({ runBatch, download })} />);
    await addFiles([file("a.png"), file("b.png")]);
    await userEvent.click(screen.getByRole("button", { name: "开始处理" }));
    const zip = await screen.findByRole("button", {
      name: "下载 2 个成功文件（ZIP）",
    });
    await userEvent.click(zip);

    const busy = screen.getByRole("button", { name: "正在打包…" });
    expect(busy).toBeDisabled();
    await userEvent.click(busy);
    expect(download).not.toHaveBeenCalled();
    await waitFor(() => expect(release).toBeTypeOf("function"));
    await release();
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
  });

  it("contains packaging failures without exposing internals", async () => {
    class BrokenBlob extends Blob {
      override stream(): ReturnType<Blob["stream"]> {
        throw new Error("secret packaging stack");
      }
    }
    const runBatch = vi.fn(async (requests: ProcessRequest[]) =>
      requests.map((request) =>
        processResult(request.id, {
          output: new BrokenBlob(["broken"], { type: "image/jpeg" }),
        }),
      ),
    );
    render(<App dependencies={dependencies({ runBatch })} />);
    await addFiles([file("a.png"), file("b.png")]);
    await userEvent.click(screen.getByRole("button", { name: "开始处理" }));
    const zip = await screen.findByRole("button", {
      name: "下载 2 个成功文件（ZIP）",
    });
    await userEvent.click(zip);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "打包失败，请重试",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("secret");
  });

  it("new batch clears stale results and ignores a stale async completion", async () => {
    let resolveBatch!: (results: ProcessResult[]) => void;
    let reportProgress!: (progress: BatchProgress) => void;
    const runBatch = vi.fn(
      (_requests: ProcessRequest[], onProgress: (value: BatchProgress) => void) =>
        new Promise<ProcessResult[]>((resolve) => {
          reportProgress = onProgress;
          resolveBatch = resolve;
        }),
    );
    render(<App dependencies={dependencies({ runBatch })} />);
    await addFiles([file()]);
    await userEvent.click(screen.getByRole("button", { name: "开始处理" }));
    await userEvent.click(screen.getByRole("button", { name: "取消处理" }));
    resolveBatch([
      processResult("商品图.png-0", {
        state: "cancelled",
        output: null,
        outputFormat: null,
      }),
    ]);
    expect(
      await screen.findByRole("button", { name: "新建批次" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "新建批次" }));
    expect(screen.getByRole("button", { name: "开始处理" })).toBeDisabled();
    expect(screen.queryByRole("heading", { name: "处理结果" })).not.toBeInTheDocument();
    reportProgress(progress(1, 1));
    expect(screen.queryByText(/已完成 1 \/ 1/)).not.toBeInTheDocument();
  });

  it("warns before leaving only for undownloaded image outputs", async () => {
    render(<App dependencies={dependencies()} />);
    await addFiles([file()]);
    await userEvent.click(screen.getByRole("button", { name: "开始处理" }));
    await screen.findByRole("button", { name: "下载处理后的图片" });

    const before = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "下载 CSV 报告" }));
    const afterCsv = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(afterCsv);
    expect(afterCsv.defaultPrevented).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "下载处理后的图片" }));
    const afterImage = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(afterImage);
    expect(afterImage.defaultPrevented).toBe(false);
  });

  it("removes the leave warning on new batch and unmount", async () => {
    const firstView = render(<App dependencies={dependencies()} />);
    await addFiles([file()]);
    await userEvent.click(screen.getByRole("button", { name: "开始处理" }));
    await screen.findByRole("button", { name: "新建批次" });
    const beforeNew = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeNew);
    expect(beforeNew.defaultPrevented).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "新建批次" }));
    const afterNew = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(afterNew);
    expect(afterNew.defaultPrevented).toBe(false);
    firstView.unmount();

    render(<App dependencies={dependencies()} />);
    await addFiles([file("again.png")]);
    await userEvent.click(screen.getByRole("button", { name: "开始处理" }));
    await screen.findByRole("button", { name: "下载处理后的图片" });
    cleanup();
    const afterUnmount = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(afterUnmount);
    expect(afterUnmount.defaultPrevented).toBe(false);
  });

  it("renders unsafe names as text and contains dependency errors", async () => {
    const unsafe = file('<img src=x onerror="alert(1)">.png');
    const inspectFiles = vi
      .fn()
      .mockResolvedValueOnce([selectedImage(unsafe, "unsafe")])
      .mockRejectedValueOnce(new Error("C:\\Users\\secret"));
    render(<App dependencies={dependencies({ inspectFiles })} />);
    await addFiles([unsafe]);
    expect(screen.getByText(unsafe.name)).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();

    fireEvent.change(inputs().files, { target: { files: [file("bad.png")] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法添加这些图片",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("Users");
  });
});
