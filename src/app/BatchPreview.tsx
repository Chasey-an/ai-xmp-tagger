import type { SelectedImage } from "../core/file-intake";

interface BatchPreviewProps {
  images: readonly SelectedImage[];
  totalBytes: number;
  warning: string | null;
  disabled: boolean;
  onRemove: (id: string) => void;
  onClear: () => void;
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatLabel(format: SelectedImage["format"]): string {
  return format === "jpeg" ? "JPG" : format.toUpperCase();
}

export function BatchPreview({
  images,
  totalBytes,
  warning,
  disabled,
  onRemove,
  onClear,
}: BatchPreviewProps) {
  if (images.length === 0) return null;

  return (
    <section class="batch-preview" aria-labelledby="batch-preview-title">
      <div class="section-bar">
        <h2 id="batch-preview-title">
          已选择 {images.length} 个文件
          <span>（共 {sizeLabel(totalBytes)}）</span>
        </h2>
        <button
          type="button"
          class="text-button"
          disabled={disabled}
          onClick={onClear}
        >
          清空列表
        </button>
      </div>
      {warning ? (
        <p class="notice notice-warning" role="status">
          ⚠ {warning}，仍可继续处理；较大的批次可能需要更长时间。
        </p>
      ) : null}
      <ul class="file-list">
        {images.map((image) => (
          <li class="file-row" key={image.id}>
            <span class="file-mark" aria-hidden="true">▧</span>
            <span class="file-main">
              <span class="file-name">{image.file.name}</span>
              <span class="file-path">
                {image.relativePath !== image.file.name
                  ? image.relativePath
                  : "单个文件"}
              </span>
            </span>
            <span class={`format-chip format-${image.format}`}>
              {formatLabel(image.format)}
            </span>
            <span class="file-size">{sizeLabel(image.file.size)}</span>
            <span class="file-warning">
              {image.warning ??
                (image.format === "jpeg"
                  ? "保持画面数据"
                  : "默认模式将转为 JPG")}
            </span>
            <button
              type="button"
              class="icon-button"
              aria-label={`移除 ${image.file.name}`}
              disabled={disabled}
              onClick={() => onRemove(image.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
