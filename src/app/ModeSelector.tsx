import type { ProcessingMode } from "../core/types";

interface ModeSelectorProps {
  value: ProcessingMode;
  disabled: boolean;
  hasBmp: boolean;
  onChange: (mode: ProcessingMode) => void;
}

const MODES: ReadonlyArray<{
  value: ProcessingMode;
  label: string;
  description: string;
}> = [
  {
    value: "jpeg-and-xmp",
    label: "转为高清 JPG 并写入标签",
    description: "JPG 无损写入；PNG、BMP、静态 WebP 转为高质量 JPG。动态 WebP 请切换保持原格式。",
  },
  {
    value: "original-and-xmp",
    label: "保持原格式并写入标签",
    description: "JPG、PNG 及静态/动态 WebP 保持原容器，不重新编码图片画面。",
  },
  {
    value: "verify-only",
    label: "只检查 XMP 标签",
    description: "只读取并生成检查报告，不修改或输出图片。",
  },
];

export function ModeSelector({
  value,
  disabled,
  hasBmp,
  onChange,
}: ModeSelectorProps) {
  return (
    <fieldset class="mode-selector" disabled={disabled}>
      <legend>1. 选择处理模式</legend>
      <div class="mode-options">
        {MODES.map((mode) => (
          <label class={`mode-option${value === mode.value ? " is-selected" : ""}`}>
            <span class="mode-option-title">
              <input
                type="radio"
                name="processing-mode"
                value={mode.value}
                aria-label={mode.label}
                checked={value === mode.value}
                onChange={() => onChange(mode.value)}
              />
              <span>{mode.label}</span>
            </span>
            <span class="mode-description">{mode.description}</span>
          </label>
        ))}
      </div>
      {hasBmp && value !== "jpeg-and-xmp" ? (
        <p class="mode-note">
          提醒：BMP 在此模式下会逐个显示为不支持；可改用“转为高清 JPG 并写入标签”。
        </p>
      ) : null}
    </fieldset>
  );
}
