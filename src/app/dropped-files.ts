import { MAX_FILES } from "../core/constants";
import { ProcessingError } from "../core/errors";
import { sanitizeRelativePath } from "../core/output/names";

const MAX_DIRECTORY_DEPTH = 32;
const MAX_TRAVERSED_ENTRIES = MAX_FILES * 8;
const MAX_READ_BATCHES = 1_000;
const droppedRelativePaths = new WeakMap<File, string>();

interface LegacyEntry {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly name: string;
  readonly fullPath?: string;
}

interface LegacyFileEntry extends LegacyEntry {
  file(
    success: (file: File) => void,
    failure?: (error: unknown) => void,
  ): void;
}

interface LegacyDirectoryReader {
  readEntries(
    success: (entries: LegacyEntry[]) => void,
    failure?: (error: unknown) => void,
  ): void;
}

interface LegacyDirectoryEntry extends LegacyEntry {
  createReader(): LegacyDirectoryReader;
}

interface LegacyDataTransferItem {
  readonly kind?: string;
  webkitGetAsEntry?: () => LegacyEntry | null;
}

function folderReadError(cause?: unknown): ProcessingError {
  return new ProcessingError(
    "CORRUPT_CONTAINER",
    "无法读取拖入的文件夹",
    cause === undefined ? undefined : { cause },
  );
}

function tooManyFiles(): ProcessingError {
  return new ProcessingError(
    "LIMIT_EXCEEDED",
    `文件数量超过 ${MAX_FILES} 个限制`,
  );
}

function sanitizeDropPath(path: string, fallback: string): string {
  const browserRelativePath = path
    .replaceAll("\\", "/")
    .replace(/^\/+/u, "");
  return sanitizeRelativePath(browserRelativePath || fallback);
}

function registerRelativePath(file: File, path: string): File {
  const safePath = sanitizeDropPath(path, file.name);
  droppedRelativePaths.set(file, safePath);
  try {
    Object.defineProperty(file, "webkitRelativePath", {
      configurable: true,
      value: safePath,
    });
  } catch {
    // Native File implementations may make this property non-configurable.
    // The WeakMap remains the authoritative local-only path source.
  }
  return file;
}

export function relativePathForFile(file: File): string {
  return (
    droppedRelativePaths.get(file) ||
    sanitizeDropPath(file.webkitRelativePath || file.name, file.name)
  );
}

function readFileEntry(entry: LegacyFileEntry): Promise<File> {
  return new Promise<File>((resolve, reject) => {
    try {
      entry.file(resolve, (error) => reject(folderReadError(error)));
    } catch (error) {
      reject(folderReadError(error));
    }
  });
}

function readEntryBatch(
  reader: LegacyDirectoryReader,
): Promise<LegacyEntry[]> {
  return new Promise<LegacyEntry[]>((resolve, reject) => {
    try {
      reader.readEntries(
        (entries) => {
          if (!Array.isArray(entries)) {
            reject(folderReadError());
            return;
          }
          resolve(entries);
        },
        (error) => reject(folderReadError(error)),
      );
    } catch (error) {
      reject(folderReadError(error));
    }
  });
}

export async function collectDroppedFiles(
  transfer: DataTransfer,
): Promise<File[]> {
  const items = Array.from(transfer.items ?? []);
  const roots: LegacyEntry[] = [];
  let entryApiAvailable = false;

  for (const item of items) {
    if (item.kind !== undefined && item.kind !== "file") continue;
    const legacyItem = item as unknown as LegacyDataTransferItem;
    const getter = legacyItem.webkitGetAsEntry;
    if (typeof getter !== "function") continue;
    entryApiAvailable = true;
    try {
      const entry = getter.call(legacyItem);
      if (entry !== null) roots.push(entry);
    } catch (error) {
      throw folderReadError(error);
    }
  }

  if (!entryApiAvailable || roots.length === 0) {
    return Array.from(transfer.files ?? []);
  }

  const files: File[] = [];
  const seenEntries = new WeakSet<object>();
  const seenRawPaths = new Set<string>();
  let traversedEntries = 0;
  let readBatches = 0;

  const traverse = async (
    entry: LegacyEntry,
    parentRawPath: string,
    depth: number,
  ): Promise<void> => {
    if (depth > MAX_DIRECTORY_DEPTH) {
      throw new ProcessingError(
        "LIMIT_EXCEEDED",
        `拖入的文件夹嵌套超过 ${MAX_DIRECTORY_DEPTH} 层限制`,
      );
    }

    const rawPath =
      entry.fullPath || `${parentRawPath}/${entry.name}`;
    const rawIdentity =
      `${entry.isDirectory ? "d" : "f"}:${rawPath}`;
    if (
      seenEntries.has(entry) ||
      seenRawPaths.has(rawIdentity)
    ) {
      return;
    }
    seenEntries.add(entry);
    seenRawPaths.add(rawIdentity);

    const entryPath = sanitizeDropPath(
      rawPath,
      entry.name,
    );

    traversedEntries += 1;
    if (traversedEntries > MAX_TRAVERSED_ENTRIES) {
      throw new ProcessingError(
        "LIMIT_EXCEEDED",
        "拖入的文件夹结构过于复杂",
      );
    }

    if (entry.isFile) {
      if (files.length >= MAX_FILES) throw tooManyFiles();
      const file = await readFileEntry(entry as LegacyFileEntry);
      files.push(registerRelativePath(file, entryPath));
      return;
    }

    if (!entry.isDirectory) return;
    let reader: LegacyDirectoryReader;
    try {
      reader = (entry as LegacyDirectoryEntry).createReader();
    } catch (error) {
      throw folderReadError(error);
    }

    while (true) {
      readBatches += 1;
      if (readBatches > MAX_READ_BATCHES) {
        throw new ProcessingError(
          "LIMIT_EXCEEDED",
          "拖入的文件夹结构过于复杂",
        );
      }
      const batch = await readEntryBatch(reader);
      if (batch.length === 0) break;
      const directFileCount = batch.filter(
        (child) => child.isFile,
      ).length;
      if (files.length + directFileCount > MAX_FILES) {
        throw tooManyFiles();
      }
      for (const child of batch) {
        await traverse(child, rawPath, depth + 1);
      }
    }
  };

  for (const root of roots) {
    await traverse(root, "", 0);
  }
  return files;
}
