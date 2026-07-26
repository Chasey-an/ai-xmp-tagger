import type { ProcessResult } from "../process-file";
import { sanitizeRelativePath } from "./names";

/**
 * Task 8 intentionally keeps ProcessResult worker-safe and does not carry the
 * source path. Task 11 may enrich a copied result with this optional,
 * user-selected relative path before creating reports. Without it, reporting
 * falls back to the output name or only the basename of the opaque id.
 */
export type ReportableProcessResult = ProcessResult & {
  readonly relativePath?: string;
};

const HEADERS = [
  "相对路径",
  "文件名",
  "状态",
  "处理结果",
  "输出格式",
  "是否重新编码",
  "目标标签数量",
  "耗时（毫秒）",
] as const;

function basename(path: string): string {
  return path.split("/").at(-1) ?? "unnamed";
}

function safeRelativePath(result: ReportableProcessResult): string {
  if (
    typeof result.relativePath === "string" &&
    result.relativePath.length > 0
  ) {
    return sanitizeRelativePath(result.relativePath);
  }
  if (
    typeof result.outputName === "string" &&
    result.outputName.length > 0
  ) {
    return sanitizeRelativePath(result.outputName);
  }
  return basename(sanitizeRelativePath(result.id));
}

function safeFilename(
  result: ReportableProcessResult,
  relativePath: string,
): string {
  if (
    typeof result.outputName === "string" &&
    result.outputName.length > 0
  ) {
    return basename(sanitizeRelativePath(result.outputName));
  }
  return basename(relativePath);
}

function stateLabel(result: ProcessResult): string {
  switch (result.state) {
    case "success":
      return "成功";
    case "checked":
      return "已检查";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
  }
}

function formatLabel(result: ProcessResult): string {
  switch (result.outputFormat) {
    case "jpeg":
      return "JPEG";
    case "png":
      return "PNG";
    case "webp":
      return "WebP";
    case "bmp":
      return "BMP";
    case null:
      return "";
  }
}

function protectFormula(value: string): string {
  return /^\s*[=+\-@]/u.test(value) ? `'${value}` : value;
}

function containsAbsoluteLocalPath(value: string): boolean {
  const windowsDrive =
    /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/u.test(value);
  const windowsNetworkOrDevice = value.includes("\\\\");
  const commonPosixRoot =
    /\/(?:Users|home|private|var|tmp|Volumes|root|etc|opt|srv|mnt|media)\//iu.test(
      value,
    );
  const genericPosixAbsolute =
    /(?:^|[\s("'`，。；;：])\/(?!\/)[^/\s]+\/[^/\s]+/u.test(
      value,
    );
  const posixRootFile =
    /(?:^|[\s("'`，。；;：])\/(?!\/)[^/\s]+(?=$|[\s,，。；;:：!?！？)"'])/u.test(
      value,
    );
  const windowsCurrentDrive =
    /(?:^|[\s("'`，。；;：])\\(?!\\)[^\\\r\n]+\\[^\\\r\n]+/u.test(
      value,
    );
  return (
    windowsDrive ||
    windowsNetworkOrDevice ||
    commonPosixRoot ||
    genericPosixAbsolute ||
    posixRootFile ||
    windowsCurrentDrive
  );
}

function safeMessage(message: string): string {
  return containsAbsoluteLocalPath(message)
    ? "处理信息包含本地文件路径，已为保护隐私隐藏；请根据状态检查源文件后重试。"
    : message;
}

function csvCell(value: string | number): string {
  const protectedValue = protectFormula(String(value));
  if (/[",\r\n]/u.test(protectedValue)) {
    return `"${protectedValue.replaceAll('"', '""')}"`;
  }
  return protectedValue;
}

export function createCsv(
  results: readonly ReportableProcessResult[],
): string {
  const rows = results.map((result) => {
    const relativePath = safeRelativePath(result);
    return [
      relativePath,
      safeFilename(result, relativePath),
      stateLabel(result),
      safeMessage(result.message),
      formatLabel(result),
      result.reencoded ? "是" : "否",
      result.targetTagCount,
      Math.max(0, Math.round(result.elapsedMs * 10) / 10),
    ]
      .map(csvCell)
      .join(",");
  });

  return `\uFEFF${HEADERS.join(",")}\r\n${
    rows.length > 0 ? `${rows.join("\r\n")}\r\n` : ""
  }`;
}
