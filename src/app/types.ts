export type AppPhase = "idle" | "ready" | "running" | "stopping" | "complete";

export interface DownloadState {
  hasUndownloadedOutputs: boolean;
  lastDownloadedAt: number | null;
}
