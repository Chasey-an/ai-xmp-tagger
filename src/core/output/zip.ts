import { downloadZip } from "client-zip";

import type { ImageFormat } from "../types";
import {
  createCsv,
  type ReportableProcessResult,
} from "./csv";
import {
  planOutputName,
  resolveNameCollisions,
  sanitizeRelativePath,
} from "./names";

const ZIP_ROOT = "AI_XMP_Output/";
const REPORT_NAME = "processing-report.csv";

function basename(path: string): string {
  return path.split("/").at(-1) ?? "unnamed";
}

function dirname(path: string): string {
  const segments = path.split("/");
  segments.pop();
  return segments.join("/");
}

function fallbackSource(result: ReportableProcessResult): string {
  if (
    typeof result.relativePath === "string" &&
    result.relativePath.length > 0
  ) {
    return sanitizeRelativePath(result.relativePath);
  }
  return basename(sanitizeRelativePath(result.id));
}

function plannedEntryName(
  result: ReportableProcessResult,
  format: ImageFormat,
): string {
  const source = fallbackSource(result);
  if (
    typeof result.outputName !== "string" ||
    result.outputName.length === 0
  ) {
    return planOutputName(source, "original-and-xmp", format);
  }

  const safeOutputName = sanitizeRelativePath(result.outputName);
  if (safeOutputName.includes("/")) {
    return safeOutputName;
  }
  const sourceDirectory = dirname(source);
  return sourceDirectory.length > 0
    ? `${sourceDirectory}/${safeOutputName}`
    : safeOutputName;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function archiveFilename(now: Date): string {
  if (Number.isNaN(now.getTime())) {
    throw new TypeError("ZIP timestamp must be a valid Date");
  }
  const date = [
    String(now.getFullYear()).padStart(4, "0"),
    twoDigits(now.getMonth() + 1),
    twoDigits(now.getDate()),
  ].join("");
  const time = `${twoDigits(now.getHours())}${twoDigits(
    now.getMinutes(),
  )}`;
  return `AI_XMP_Output_${date}-${time}.zip`;
}

export async function createOutputZip(
  results: readonly ReportableProcessResult[],
  now: Date,
): Promise<{ filename: string; blob: Blob }> {
  const successful: Array<{
    result: ReportableProcessResult & {
      output: Blob;
      outputFormat: ImageFormat;
    };
    resultIndex: number;
  }> = [];
  for (const [resultIndex, result] of results.entries()) {
    if (
      result.state === "success" &&
      result.output instanceof Blob &&
      result.outputFormat !== null
    ) {
      successful.push({
        result: result as ReportableProcessResult & {
          output: Blob;
          outputFormat: ImageFormat;
        },
        resultIndex,
      });
    }
  }
  const plannedNames = successful.map(({ result }) =>
    plannedEntryName(result, result.outputFormat),
  );
  // Reserve the report's fixed root name before resolving image collisions.
  const resolvedNames = resolveNameCollisions([
    REPORT_NAME,
    ...plannedNames,
  ]).slice(1);
  const packagedNameByResultIndex = new Map<number, string>();
  for (const [index, item] of successful.entries()) {
    const name = resolvedNames[index];
    if (name !== undefined) {
      packagedNameByResultIndex.set(item.resultIndex, name);
    }
  }
  const reportResults = results.map((result, resultIndex) => {
    const packagedName = packagedNameByResultIndex.get(resultIndex);
    return packagedName === undefined
      ? result
      : {
          ...result,
          relativePath: packagedName,
          outputName: basename(packagedName),
        };
  });
  const report = createCsv(reportResults);

  function* inputs() {
    for (const [index, item] of successful.entries()) {
      const name = resolvedNames[index];
      if (name === undefined) {
        throw new Error("Missing resolved ZIP entry name");
      }
      yield {
        input: item.result.output,
        name: `${ZIP_ROOT}${name}`,
        lastModified: now,
      };
    }
    yield {
      input: report,
      name: `${ZIP_ROOT}${REPORT_NAME}`,
      lastModified: now,
    };
  }

  const response = downloadZip(inputs(), { buffersAreUTF8: true });
  return {
    filename: archiveFilename(now),
    blob: await response.blob(),
  };
}
