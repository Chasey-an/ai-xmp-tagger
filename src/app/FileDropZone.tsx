import { useRef } from "preact/hooks";

const ACCEPT =
  ".jpg,.jpeg,.png,.webp,.bmp,image/jpeg,image/png,image/webp,image/bmp";

interface FileDropZoneProps {
  disabled: boolean;
  busy: boolean;
  onFiles: (files: File[]) => void;
}

function filesFrom(list: FileList | null): File[] {
  return list === null ? [] : Array.from(list);
}

export function FileDropZone({
  disabled,
  busy,
  onFiles,
}: FileDropZoneProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const openFiles = () => {
    if (!disabled) fileInput.current?.click();
  };

  return (
    <div
      class={`drop-zone${disabled ? " is-disabled" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        if (!disabled) onFiles(filesFrom(event.dataTransfer?.files ?? null));
      }}
    >
      <div
        class="drop-target"
        role="button"
        aria-label="添加图片"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
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
          disabled={disabled}
          onClick={openFiles}
        >
          选择图片
        </button>
        <button
          class="button button-secondary"
          type="button"
          disabled={disabled}
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
        disabled={disabled}
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
        disabled={disabled}
        onChange={(event) => {
          onFiles(filesFrom(event.currentTarget.files));
          event.currentTarget.value = "";
        }}
      />
    </div>
  );
}
