interface DownloadPanelProps {
  successfulOutputs: number;
  hasResults: boolean;
  packaging: boolean;
  onPrimaryDownload: () => void;
  onCsvDownload: () => void;
  onNewBatch: () => void;
}

export function DownloadPanel({
  successfulOutputs,
  hasResults,
  packaging,
  onPrimaryDownload,
  onCsvDownload,
  onNewBatch,
}: DownloadPanelProps) {
  if (!hasResults) return null;

  return (
    <section class="download-panel" aria-label="下载处理结果">
      <div class="download-actions">
        {successfulOutputs === 1 ? (
          <button
            type="button"
            class="button button-primary"
            disabled={packaging}
            onClick={onPrimaryDownload}
          >
            下载处理后的图片
          </button>
        ) : null}
        {successfulOutputs >= 2 ? (
          <button
            type="button"
            class="button button-primary"
            disabled={packaging}
            onClick={onPrimaryDownload}
          >
            {packaging
              ? "正在打包…"
              : `下载 ${successfulOutputs} 个成功文件（ZIP）`}
          </button>
        ) : null}
        <button
          type="button"
          class="button button-secondary"
          disabled={packaging}
          onClick={onCsvDownload}
        >
          下载 CSV 报告
        </button>
      </div>
      <button
        type="button"
        class="text-button new-batch"
        disabled={packaging}
        onClick={onNewBatch}
      >
        新建批次
      </button>
    </section>
  );
}
