import { useRef } from "preact/hooks";

const ACCEPT =
  ".jpg,.jpeg,.png,.webp,.bmp,image/jpeg,image/png,image/webp,image/bmp";

interface FileDropZoneProps {
  disabled: boolean;
  busy: boolean;
  onFiles: (files: File[]) => void;
  onDrop: (transfer: DataTransfer) => void;
}

function filesFrom(list: FileList | null): File[] {
  return list === null ? [] : Array.from(list);
}

export function FileDropZone({
  disabled,
  busy,
  onFiles,
  onDrop,
}: FileDropZoneProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const controlsDisabled = disabled || busy;

  const openFiles = () => {
    if (!controlsDisabled) fileInput.current?.click();
  };

  return (
    <div
      class={
        `drop-zone${disabled ? " is-disabled" : ""}` +
        `${busy ? " is-busy" : ""}`
      }
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const transfer = event.dataTransfer;
        if (disabled || transfer === null) return;
        onDrop(transfer);
      }}
    >
      <div
        class="drop-target"
        role="button"
        aria-label="添加图片"
        tabIndex={controlsDisabled ? -1 : 0}
        aria-disabled={disabled}
        aria-busy={busy}
        onClick={openFiles}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openFiles();
          }
        }}
      >
        <span class="upload-icon" aria-hidden="true">
          ↑
        </span>
        <strong>拖入图片或文件夹</strong>
        <span>支持 JPG、JPEG、PNG、WebP、BMP（单个文件 ≤ 50 MiB）</span>
      </div>
      <div class="drop-actions">
        <button
          class="button button-primary"
          type="button"
          disabled={controlsDisabled}
          onClick={openFiles}
        >
          选择图片
        </button>
        <button
          class="button button-secondary"
          type="button"
          disabled={controlsDisabled}
          onClick={() => folderInput.current?.click()}
        >
          选择文件夹
        </button>
        {busy ? <span class="intake-busy" role="status">正在读取…</span> : null}
      </div>
      <input
        ref={fileInput}
        class="visually-hidden"
        type="file"
        multiple
        accept={ACCEPT}
        aria-label="选择图片文件"
        disabled={controlsDisabled}
        onChange={(event) => {
          onFiles(filesFrom(event.currentTarget.files));
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={(element) => {
          folderInput.current = element;
          element?.setAttribute("webkitdirectory", "");
        }}
        class="visually-hidden"
        type="file"
        multiple
        accept={ACCEPT}
        aria-label="选择图片文件夹"
        disabled={controlsDisabled}
        onChange={(event) => {
          onFiles(filesFrom(event.currentTarget.files));
          event.currentTarget.value = "";
        }}
      />
    </div>
  );
}
