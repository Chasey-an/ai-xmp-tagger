import type { BatchProgress } from "../core/batch-runner";
import type { AppPhase } from "./types";

interface ProgressPanelProps {
  phase: AppPhase;
  progress: BatchProgress;
  onCancel: () => void;
}

export function ProgressPanel({
  phase,
  progress,
  onCancel,
}: ProgressPanelProps) {
  if (phase !== "running" && phase !== "stopping") return null;

  const percent =
    progress.total === 0
      ? 0
      : Math.round((progress.completed / progress.total) * 100);

  return (
    <section class="progress-panel" aria-labelledby="progress-title">
      <div class="section-bar">
        <h2 id="progress-title">2. 处理进度</h2>
        <button
          class="button button-secondary"
          type="button"
          disabled={phase === "stopping"}
          onClick={onCancel}
        >
          {phase === "stopping" ? "正在停止…" : "取消处理"}
        </button>
      </div>
      <progress value={progress.completed} max={Math.max(progress.total, 1)}>
        {percent}%
      </progress>
      <div class="progress-counts" aria-live="polite">
        <strong>已完成 {progress.completed} / {progress.total}</strong>
        <span>成功 {progress.success}</span>
        <span>已检查 {progress.checked}</span>
        <span>失败 {progress.failed}</span>
        <span>已取消 {progress.cancelled}</span>
        <span>{percent}%</span>
      </div>
    </section>
  );
}
