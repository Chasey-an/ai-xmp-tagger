import { downloadZip } from "client-zip";

import type { ImageFormat } from "../types";
import {
  createCsv,
  type ReportableProcessResult,
} from "./csv";
import {
  alignOutputNameToFormat,
  canonicalOutputNameKey,
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

  const safeOutputName = alignOutputNameToFormat(
    result.outputName,
    format,
  );
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

function dosSafeDate(now: Date): Date {
  if (Number.isNaN(now.getTime())) {
    throw new TypeError("ZIP timestamp must be a valid Date");
  }
  const year = now.getFullYear();
  if (year < 1980) {
    return new Date(1980, 0, 1, 0, 0, 0, 0);
  }
  if (year > 2107) {
    return new Date(2107, 11, 31, 23, 59, 58, 999);
  }
  return new Date(now.getTime());
}

function snapshotResult(
  result: ReportableProcessResult,
): Readonly<ReportableProcessResult> {
  const snapshot = {
    id: result.id,
    state: result.state,
    output: result.output,
    outputFormat: result.outputFormat,
    outputName: result.outputName,
    subjectExists: result.subjectExists,
    targetTagCount: result.targetTagCount,
    reencoded: result.reencoded,
    message: result.message,
    elapsedMs: result.elapsedMs,
  };
  return Object.freeze(
    typeof result.relativePath === "string"
      ? { ...snapshot, relativePath: result.relativePath }
      : snapshot,
  );
}

function assertUniqueZipNames(names: readonly string[]): void {
  const canonicalNames = new Set<string>();
  const encodedNames = new Set<string>();
  const encoder = new TextEncoder();
  for (const name of names) {
    const canonical = canonicalOutputNameKey(name);
    const encoded = Array.from(encoder.encode(name)).join(",");
    if (
      canonicalNames.has(canonical) ||
      encodedNames.has(encoded)
    ) {
      throw new Error("Duplicate ZIP entry name after normalization");
    }
    canonicalNames.add(canonical);
    encodedNames.add(encoded);
  }
}

export async function createOutputZip(
  results: readonly ReportableProcessResult[],
  now: Date,
): Promise<{ filename: string; blob: Blob }> {
  const snapshotDate = dosSafeDate(now);
  const filename = archiveFilename(snapshotDate);
  const snapshots = Object.freeze(results.map(snapshotResult));
  const successful: Array<{
    result: Readonly<ReportableProcessResult>;
    output: Blob;
    outputFormat: ImageFormat;
    resultIndex: number;
  }> = [];
  for (const [resultIndex, result] of snapshots.entries()) {
    if (
      result.state === "success" &&
      result.output !== null &&
      result.outputFormat !== null
    ) {
      successful.push({
        result,
        output: result.output,
        outputFormat: result.outputFormat,
        resultIndex,
      });
    }
  }
  const plannedNames = successful.map(({ result, outputFormat }) =>
    plannedEntryName(result, outputFormat),
  );
  // Reserve the report's fixed root name before resolving image collisions.
  const resolvedNames = resolveNameCollisions([
    REPORT_NAME,
    ...plannedNames,
  ]).slice(1);
  assertUniqueZipNames([
    ...resolvedNames.map((name) => `${ZIP_ROOT}${name}`),
    `${ZIP_ROOT}${REPORT_NAME}`,
  ]);
  const packagedNameByResultIndex = new Map<number, string>();
  for (const [index, item] of successful.entries()) {
    const name = resolvedNames[index];
    if (name !== undefined) {
      packagedNameByResultIndex.set(item.resultIndex, name);
    }
  }
  const reportResults = snapshots.map((result, resultIndex) => {
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
        input: item.output,
        name: `${ZIP_ROOT}${name}`,
        lastModified: snapshotDate,
      };
    }
    yield {
      input: report,
      name: `${ZIP_ROOT}${REPORT_NAME}`,
      lastModified: snapshotDate,
    };
  }

  const response = downloadZip(inputs(), { buffersAreUTF8: true });
  return {
    filename,
    blob: await response.blob(),
  };
}
