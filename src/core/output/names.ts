import type { ImageFormat, ProcessingMode } from "../types";

/**
 * Conservative cross-platform limits measured in UTF-8 bytes. Keeping the
 * relative path at 512 bytes also keeps `AI_XMP_Output/` ZIP entries below
 * 540 bytes after collision suffixes are added.
 */
const MAX_SEGMENT_BYTES = 120;
const MAX_RELATIVE_PATH_BYTES = 512;

const WINDOWS_RESERVED_BASENAME =
  /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM(?:[1-9]|[¹²³])|LPT(?:[1-9]|[¹²³]))$/i;
const REMOVED_CONTROLS =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu;
const WINDOWS_INVALID_CHARACTERS = /[<>:"|?*]/gu;

const encoder = new TextEncoder();

function toWellFormed(value: string): string {
  const native = (
    String.prototype as String & {
      toWellFormed?: () => string;
    }
  ).toWellFormed;
  if (typeof native === "function") {
    return native.call(value);
  }

  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] ?? "";
        result += value[index + 1] ?? "";
        index += 1;
      } else {
        result += "\uFFFD";
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      result += "\uFFFD";
    } else {
      result += value[index] ?? "";
    }
  }
  return result;
}

function utf8Length(value: string): number {
  return encoder.encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Length(value) <= maxBytes) {
    return value;
  }

  let result = "";
  let used = 0;
  for (const character of value) {
    const size = utf8Length(character);
    if (used + size > maxBytes) {
      break;
    }
    result += character;
    used += size;
  }
  return result;
}

function splitExtension(segment: string): {
  stem: string;
  extension: string;
} {
  const dot = segment.lastIndexOf(".");
  if (dot <= 0 || dot === segment.length - 1) {
    return { stem: segment, extension: "" };
  }
  const extension = segment.slice(dot);
  // Image extensions are tiny. An attacker-controlled, extension-like tail
  // should not consume the entire segment budget.
  if (utf8Length(extension) > 24) {
    return { stem: segment, extension: "" };
  }
  return { stem: segment.slice(0, dot), extension };
}

function truncateSegment(
  stem: string,
  extension: string,
  suffix = "",
): string {
  const fixedBytes = utf8Length(extension) + utf8Length(suffix);
  const available = Math.max(1, MAX_SEGMENT_BYTES - fixedBytes);
  const boundedStem = truncateUtf8(stem, available) || "unnamed";
  return `${boundedStem}${suffix}${extension}`;
}

function protectReservedBasename(segment: string): string {
  const firstDot = segment.indexOf(".");
  const deviceBasename =
    firstDot < 0 ? segment : segment.slice(0, firstDot);
  if (!WINDOWS_RESERVED_BASENAME.test(deviceBasename)) {
    return segment;
  }
  return firstDot < 0
    ? `${segment}-file`
    : `${deviceBasename}-file${segment.slice(firstDot)}`;
}

function sanitizeSegment(rawSegment: string): string {
  const normalized = rawSegment
    .normalize("NFC")
    .replace(REMOVED_CONTROLS, "")
    .replace(WINDOWS_INVALID_CHARACTERS, "")
    .replace(/[. ]+$/u, "");
  const fallback = normalized || "unnamed";
  const protectedName = protectReservedBasename(fallback);
  const { stem, extension } = splitExtension(protectedName);
  return truncateSegment(stem, extension);
}

function stripPathRoot(path: string): {
  relative: string;
  rooted: boolean;
} {
  let relative = path;
  const rooted =
    relative.startsWith("/") || /^[A-Za-z]:/u.test(relative);

  if (/^\/\/[?.]\//u.test(relative)) {
    relative = relative.slice(4);
    if (/^UNC\//iu.test(relative)) {
      relative = relative.slice(4);
      const parts = relative.split("/");
      relative = parts.slice(2).join("/");
    }
  } else if (relative.startsWith("//")) {
    const parts = relative.slice(2).split("/");
    relative = parts.slice(2).join("/");
  }

  relative = relative.replace(/^\/+/u, "");
  relative = relative.replace(/^[A-Za-z]:\/?/u, "");
  return { relative, rooted };
}

function boundRelativePath(segments: string[]): string {
  const bounded = [...segments];
  while (
    bounded.length > 1 &&
    utf8Length(bounded.join("/")) > MAX_RELATIVE_PATH_BYTES
  ) {
    bounded.shift();
  }

  if (utf8Length(bounded.join("/")) > MAX_RELATIVE_PATH_BYTES) {
    const filename = bounded.at(-1) ?? "unnamed";
    const { stem, extension } = splitExtension(filename);
    bounded[bounded.length - 1] = truncateSegment(
      stem,
      extension,
    );
  }
  return bounded.join("/");
}

export function sanitizeRelativePath(path: string): string {
  const normalized = toWellFormed(String(path))
    .normalize("NFC")
    .replaceAll("\\", "/");
  const { relative, rooted } = stripPathRoot(normalized);
  const segments: string[] = [];

  for (const rawSegment of relative.split("/")) {
    if (
      rawSegment === "" ||
      rawSegment === "." ||
      rawSegment === ".."
    ) {
      continue;
    }
    const segment = sanitizeSegment(rawSegment);
    if (segment === "." || segment === "..") {
      continue;
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    return "unnamed";
  }
  return boundRelativePath(
    rooted ? [segments.at(-1) ?? "unnamed"] : segments,
  );
}

function extensionFor(format: ImageFormat): string {
  switch (format) {
    case "jpeg":
      return ".jpg";
    case "png":
      return ".png";
    case "webp":
      return ".webp";
    case "bmp":
      return ".bmp";
  }
}

export function planOutputName(
  path: string,
  _mode: ProcessingMode,
  format: ImageFormat,
): string {
  const safePath = sanitizeRelativePath(path);
  const segments = safePath.split("/");
  const filename = segments.pop() ?? "unnamed";
  const { stem } = splitExtension(filename);
  const extension = extensionFor(format);
  const outputFilename = truncateSegment(stem, extension, "_xmp");
  return boundRelativePath([...segments, outputFilename]);
}

export function canonicalOutputNameKey(path: string): string {
  return toWellFormed(path)
    .normalize("NFC")
    .toUpperCase()
    .normalize("NFC");
}

/**
 * Sanitizes an existing planned name and forces its extension to match the
 * detected, actual output format without adding another `_xmp` suffix.
 */
export function alignOutputNameToFormat(
  path: string,
  format: ImageFormat,
): string {
  const safePath = sanitizeRelativePath(path);
  const segments = safePath.split("/");
  const filename = segments.pop() ?? "unnamed";
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  return boundRelativePath([
    ...segments,
    truncateSegment(stem, extensionFor(format)),
  ]);
}

function withCollisionSuffix(path: string, sequence: number): string {
  const segments = path.split("/");
  const filename = segments.pop() ?? "unnamed";
  const { stem, extension } = splitExtension(filename);
  const familyStem = stem.replace(/-[2-9]\d*$/u, "");
  const suffixed = truncateSegment(
    familyStem,
    extension,
    `-${sequence}`,
  );
  return boundRelativePath([...segments, suffixed]);
}

export function resolveNameCollisions(paths: string[]): string[] {
  const safePaths = paths.map((path) => sanitizeRelativePath(path));
  const reserved = new Set(
    safePaths.map(canonicalOutputNameKey),
  );
  const used = new Set<string>();

  return safePaths.map((path) => {
    const key = canonicalOutputNameKey(path);
    if (!used.has(key)) {
      used.add(key);
      return path;
    }

    let sequence = 2;
    let candidate = withCollisionSuffix(path, sequence);
    while (
      used.has(canonicalOutputNameKey(candidate)) ||
      reserved.has(canonicalOutputNameKey(candidate))
    ) {
      sequence += 1;
      candidate = withCollisionSuffix(path, sequence);
    }
    used.add(canonicalOutputNameKey(candidate));
    return candidate;
  });
}
