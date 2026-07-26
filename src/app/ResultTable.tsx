import type { ReportableProcessResult } from "../core/output/csv";
import type { ProcessingMode } from "../core/types";

interface ResultTableProps {
  results: readonly ReportableProcessResult[];
  mode: ProcessingMode;
  headingRef: { current: HTMLHeadingElement | null };
}

const MODE_LABELS: Record<ProcessingMode, string> = {
  "jpeg-and-xmp": "转为高清 JPG 并写入",
  "original-and-xmp": "保持原格式并写入",
  "verify-only": "只检查 XMP",
};

function stateLabel(state: ReportableProcessResult["state"]): string {
  switch (state) {
    case "success":
      return "✓ 成功";
    case "checked":
      return "✓ 已检查";
    case "failed":
      return "× 失败";
    case "cancelled":
      return "— 已取消";
  }
}

function tagLabel(result: ReportableProcessResult): string {
  if (result.targetTagCount === 1) return "✓ 包含";
  if (result.targetTagCount > 1) return `⚠ 重复 ${result.targetTagCount} 次`;
  return "× 缺失";
}

function displayName(result: ReportableProcessResult): string {
  return result.relativePath ?? result.outputName ?? result.id;
}

export function ResultTable({
  results,
  mode,
  headingRef,
}: ResultTableProps) {
  const counts = results.reduce(
    (summary, result) => {
      summary[result.state] += 1;
      return summary;
    },
    { success: 0, checked: 0, failed: 0, cancelled: 0 },
  );
  const summary =
    `成功 ${counts.success} / 已检查 ${counts.checked} / ` +
    `失败 ${counts.failed} / 已取消 ${counts.cancelled} / ` +
    `总计 ${results.length}`;

  return (
    <section class="results-panel" aria-labelledby="results-title">
      <div class="section-bar results-heading">
        <h2 id="results-title" ref={headingRef} tabIndex={-1}>
          处理结果
        </h2>
        <p class="result-summary" aria-live="polite">{summary}</p>
      </div>
      <div class="table-shell">
        <table>
          <thead>
            <tr>
              <th scope="col">文件</th>
              <th scope="col">模式</th>
              <th scope="col">状态</th>
              <th scope="col">标签</th>
              <th scope="col">说明</th>
            </tr>
          </thead>
          <tbody>
            {results.map((result) => (
              <tr key={result.id}>
                <td data-label="文件">{displayName(result)}</td>
                <td data-label="模式">{MODE_LABELS[mode]}</td>
                <td data-label="状态" class={`state-${result.state}`}>
                  {stateLabel(result.state)}
                </td>
                <td data-label="标签">{tagLabel(result)}</td>
                <td data-label="说明">{result.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
