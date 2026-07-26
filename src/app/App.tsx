import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";

import { BatchRunner, type BatchProgress } from "../core/batch-runner";
import { ProcessingError } from "../core/errors";
import {
  applyBatchPolicy,
  inspectSelectedFile,
  mergeSelectedImages,
  type SelectedImage,
} from "../core/file-intake";
import { createCsv, type ReportableProcessResult } from "../core/output/csv";
import {
  planOutputName,
  resolveNameCollisions,
  sanitizeRelativePath,
} from "../core/output/names";
import { createOutputZip } from "../core/output/zip";
import type { ProcessRequest, ProcessResult } from "../core/process-file";
import type { ProcessingMode } from "../core/types";
import { BatchPreview } from "./BatchPreview";
import { DownloadPanel } from "./DownloadPanel";
import { relativePathForFile } from "./dropped-files";
import { FileDropZone } from "./FileDropZone";
import { HelpSections } from "./HelpSections";
import { ModeSelector } from "./ModeSelector";
import { ProgressPanel } from "./ProgressPanel";
import { ResultTable } from "./ResultTable";
import type { AppPhase } from "./types";

export interface AppDependencies {
  inspectFiles(files: File[]): Promise<SelectedImage[]>;
  runBatch(
    requests: ProcessRequest[],
    onProgress: (progress: BatchProgress) => void,
  ): Promise<ProcessResult[]>;
  cancelBatch(): void;
  download(blob: Blob, filename: string): void;
}

interface AppProps {
  dependencies?: AppDependencies;
}

const EMPTY_PROGRESS: BatchProgress = {
  total: 0,
  completed: 0,
  success: 0,
  checked: 0,
  failed: 0,
  cancelled: 0,
  current: null,
};

function createDefaultDependencies(): AppDependencies {
  const runner = new BatchRunner();
  return {
    inspectFiles: async (files) =>
      Promise.all(
        files.map((file) =>
          inspectSelectedFile(
            file,
            relativePathForFile(file),
          ),
        ),
      ),
    runBatch: (requests, onProgress) =>
      runner.run(requests, onProgress),
    cancelBatch: () => runner.cancel(),
    download: (blob, filename) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.rel = "noopener";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    },
  };
}

function safeErrorMessage(kind: "batch" | "download"): string {
  switch (kind) {
    case "batch":
      return "批次处理失败，请重试；如仍失败，请减少文件数量。";
    case "download":
      return "打包失败，请重试。处理结果仍保留在当前页面。";
  }
}

function safeIntakeError(error: unknown): string {
  if (!(error instanceof ProcessingError)) {
    return "无法添加这些图片。请确认格式和大小后重试。";
  }

  if (error.code === "LIMIT_EXCEEDED") {
    if (/单个文件|50 MiB/u.test(error.message)) {
      return "单个文件不能超过 50 MiB。请压缩图片后重试，或使用桌面应用处理较大的文件。";
    }
    if (/文件数量|300 个/u.test(error.message)) {
      return "一次最多处理 300 个文件。请拆分为多个批次；大量图片建议使用桌面应用。";
    }
    if (/总大小|500 MiB/u.test(error.message)) {
      return "批次总大小不能超过 500 MiB。请拆分批次后重试，或使用桌面应用。";
    }
    if (/嵌套/u.test(error.message)) {
      return "文件夹嵌套层级过深。请拆分文件夹后重试。";
    }
    return "拖入的文件夹内容过于复杂。请拆分文件夹后重试。";
  }
  if (error.code === "UNSUPPORTED_FORMAT") {
    return "包含不支持的文件。请仅选择 JPG、JPEG、PNG、WebP 或 BMP 图片。";
  }
  if (
    error.code === "CORRUPT_CONTAINER" &&
    /文件夹/u.test(error.message)
  ) {
    return "无法读取拖入的文件夹。请改用“选择文件夹”按钮，或拆分文件夹后重试。";
  }
  return "无法读取图片。请确认文件完整后重试。";
}

function enrichResults(
  workerResults: readonly ProcessResult[],
  selected: readonly SelectedImage[],
  mode: ProcessingMode,
): ReportableProcessResult[] {
  const sources = new Map(selected.map((image) => [image.id, image]));
  const planned = workerResults.map((result) => {
    const source = sources.get(result.id);
    const relativePath = sanitizeRelativePath(
      source?.relativePath ?? source?.file.name ?? result.id,
    );
    const outputName =
      result.state === "success" && result.outputFormat !== null
        ? planOutputName(relativePath, mode, result.outputFormat)
        : null;
    return { result, relativePath, outputName };
  });
  const resolvedNames = resolveNameCollisions(
    planned
      .filter(
        (
          item,
        ): item is typeof item & { outputName: string } =>
          item.outputName !== null,
      )
      .map((item) => item.outputName),
  );
  let successfulIndex = 0;

  return planned.map(({ result, relativePath, outputName }) => {
    const resolved =
      outputName === null
        ? null
        : (resolvedNames[successfulIndex++] ?? outputName);
    return {
      ...result,
      relativePath,
      outputName: resolved,
    };
  });
}

function totalBytesOf(images: readonly SelectedImage[]): number {
  return images.reduce((total, image) => total + image.file.size, 0);
}

export function App({ dependencies }: AppProps) {
  const dependencyRef = useRef<AppDependencies | null>(null);
  if (dependencyRef.current === null) {
    dependencyRef.current = dependencies ?? createDefaultDependencies();
  }
  const services = dependencyRef.current;

  const [phase, setPhase] = useState<AppPhase>("idle");
  const [mode, setMode] = useState<ProcessingMode>("jpeg-and-xmp");
  const [resultMode, setResultMode] =
    useState<ProcessingMode>("jpeg-and-xmp");
  const [images, setImages] = useState<SelectedImage[]>([]);
  const [batchWarning, setBatchWarning] = useState<string | null>(null);
  const [progress, setProgress] = useState<BatchProgress>(EMPTY_PROGRESS);
  const [results, setResults] = useState<ReportableProcessResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [intakeBusy, setIntakeBusy] = useState(false);
  const [packaging, setPackaging] = useState(false);
  const [outputsDownloaded, setOutputsDownloaded] = useState(false);
  const runGeneration = useRef(0);
  const intakeGeneration = useRef(0);
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const locked = phase === "running" || phase === "stopping";

  const successful = useMemo(
    () =>
      results.filter(
        (
          result,
        ): result is ReportableProcessResult & {
          output: Blob;
          outputFormat: NonNullable<ProcessResult["outputFormat"]>;
          outputName: string;
        } =>
          result.state === "success" &&
          result.output instanceof Blob &&
          result.outputFormat !== null &&
          typeof result.outputName === "string",
      ),
    [results],
  );

  useEffect(() => {
    if (phase === "complete") {
      resultsHeading.current?.focus();
    }
  }, [phase]);

  useLayoutEffect(() => {
    const shouldWarn =
      successful.length > 0 && !outputsDownloaded;
    if (!shouldWarn) return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [outputsDownloaded, successful.length]);

  useEffect(
    () => () => {
      runGeneration.current += 1;
      intakeGeneration.current += 1;
    },
    [],
  );

  const addFiles = async (files: File[]) => {
    if (locked || files.length === 0) return;
    const generation = ++intakeGeneration.current;
    setError(null);
    setIntakeBusy(true);
    try {
      const inspected = await services.inspectFiles(files);
      if (generation !== intakeGeneration.current) return;
      const merged = mergeSelectedImages(images, inspected);
      const policy = applyBatchPolicy(merged);
      setImages(merged);
      setBatchWarning(policy.warning);
      setPhase(merged.length > 0 ? "ready" : "idle");
    } catch (error) {
      if (generation === intakeGeneration.current) {
        setError(safeIntakeError(error));
      }
    } finally {
      if (generation === intakeGeneration.current) {
        setIntakeBusy(false);
      }
    }
  };

  const updateImages = (next: SelectedImage[]) => {
    intakeGeneration.current += 1;
    setImages(next);
    setError(null);
    try {
      const policy = applyBatchPolicy(next);
      setBatchWarning(policy.warning);
      setPhase(next.length > 0 ? "ready" : "idle");
    } catch (error) {
      setBatchWarning(null);
      setError(safeIntakeError(error));
    }
  };

  const start = async () => {
    if (phase !== "ready" || images.length === 0) return;
    const generation = ++runGeneration.current;
    const selectedSnapshot = [...images];
    const modeSnapshot = mode;
    const requests: ProcessRequest[] = selectedSnapshot.map((image) => ({
      id: image.id,
      file: image.file,
      format: image.format,
      relativePath: image.relativePath,
      mode: modeSnapshot,
    }));
    setError(null);
    setResults([]);
    setOutputsDownloaded(false);
    setProgress({ ...EMPTY_PROGRESS, total: requests.length });
    setPhase("running");

    try {
      const workerResults = await services.runBatch(
        requests,
        (nextProgress) => {
          if (generation === runGeneration.current) {
            setProgress({ ...nextProgress });
          }
        },
      );
      if (generation !== runGeneration.current) return;
      setResults(
        enrichResults(workerResults, selectedSnapshot, modeSnapshot),
      );
      setResultMode(modeSnapshot);
      setPhase("complete");
    } catch {
      if (generation === runGeneration.current) {
        setError(safeErrorMessage("batch"));
        setResults([]);
        setPhase("complete");
      }
    }
  };

  const cancel = () => {
    if (phase !== "running") return;
    setPhase("stopping");
    services.cancelBatch();
  };

  const downloadPrimary = async () => {
    if (packaging || successful.length === 0) return;
    setError(null);
    setPackaging(true);
    try {
      if (successful.length === 1) {
        const item = successful[0]!;
        services.download(item.output, item.outputName);
      } else {
        const archive = await createOutputZip(results, new Date());
        services.download(archive.blob, archive.filename);
      }
      setOutputsDownloaded(true);
    } catch {
      setError(safeErrorMessage("download"));
    } finally {
      setPackaging(false);
    }
  };

  const downloadCsv = () => {
    if (packaging || phase !== "complete") return;
    setError(null);
    try {
      const csv = createCsv(results);
      services.download(
        new Blob([csv], { type: "text/csv;charset=utf-8" }),
        "processing-report.csv",
      );
    } catch {
      setError(safeErrorMessage("download"));
    }
  };

  const newBatch = () => {
    runGeneration.current += 1;
    intakeGeneration.current += 1;
    setImages([]);
    setBatchWarning(null);
    setProgress(EMPTY_PROGRESS);
    setResults([]);
    setError(null);
    setPackaging(false);
    setOutputsDownloaded(false);
    setPhase("idle");
  };

  return (
    <>
      <a class="skip-link" href="#workbench">跳到处理工具</a>
      <header class="site-header">
        <a class="brand" href="#workbench" aria-label="AI XMP Tagger 首页">
          <span class="brand-mark" aria-hidden="true">X</span>
          AI XMP Tagger
        </a>
        <nav aria-label="页面导航">
          <a href="#instructions">使用说明</a>
          <a href="#privacy">隐私说明</a>
        </nav>
      </header>

      <main id="workbench" class="page">
        <div class="workbench">
          <div class="step-rail" aria-hidden="true">
            <span>1</span>
            <i />
            <span>2</span>
            <i />
            <span>3</span>
          </div>
          <div class="workbench-body">
            <section class="intro">
              <h1>批量添加 AI 生成人物 XMP 标签</h1>
              <p>图片只在当前浏览器处理，不会上传服务器</p>
            </section>
            <ModeSelector
              value={mode}
              disabled={locked}
              hasBmp={images.some((image) => image.format === "bmp")}
              onChange={setMode}
            />
            <FileDropZone
              disabled={locked}
              busy={intakeBusy}
              onFiles={addFiles}
              onDropError={(dropError) =>
                setError(safeIntakeError(dropError))
              }
            />
            <BatchPreview
              images={images}
              totalBytes={totalBytesOf(images)}
              warning={batchWarning}
              disabled={locked}
              mode={mode}
              onRemove={(id) =>
                updateImages(images.filter((image) => image.id !== id))
              }
              onClear={() => updateImages([])}
            />
            <div class="start-row">
              <button
                class="button button-primary button-start"
                type="button"
                disabled={phase !== "ready" || intakeBusy}
                onClick={start}
              >
                开始处理
              </button>
            </div>

            <ProgressPanel
              phase={phase}
              progress={progress}
              onCancel={cancel}
            />

            {phase === "complete" ? (
              <ResultTable
                results={results}
                mode={resultMode}
                headingRef={resultsHeading}
              />
            ) : null}

            <div class="error-slot" aria-live="assertive">
              {error ? <p class="notice notice-error" role="alert">{error}</p> : null}
            </div>

            {phase === "complete" ? (
              <DownloadPanel
                successfulOutputs={successful.length}
                hasResults
                packaging={packaging}
                onPrimaryDownload={downloadPrimary}
                onCsvDownload={downloadCsv}
                onNewBatch={newBatch}
              />
            ) : null}

            <HelpSections />
          </div>
        </div>
      </main>

      <footer class="site-footer">
        <p>
          AI XMP Tagger 是独立的浏览器本地工具，与 Amazon 无隶属或官方合作关系。
        </p>
      </footer>
    </>
  );
}
