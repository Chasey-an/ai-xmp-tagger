import type { ImageFormat, ProcessingMode } from "../types";

/**
 * Conservative cross-platform limits measured in UTF-8 bytes. Keeping the
 * relative path at 512 bytes also keeps `AI_XMP_Output/` ZIP entries below
 * 540 bytes after collision suffixes are added.
 */
const MAX_SEGMENT_BYTES = 120;
const MAX_RELATIVE_PATH_BYTES = 512;

const WINDOWS_RESERVED_BASENAME =
  /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])$/i;
const REMOVED_CONTROLS =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu;
const WINDOWS_INVALID_CHARACTERS = /[<>:"|?*]/gu;

const encoder = new TextEncoder();

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
  const normalized = String(path)
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

function extensionFor(
  mode: ProcessingMode,
  format: ImageFormat,
): string {
  if (mode === "jpeg-and-xmp") {
    return ".jpg";
  }
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
  mode: ProcessingMode,
  format: ImageFormat,
): string {
  const safePath = sanitizeRelativePath(path);
  const segments = safePath.split("/");
  const filename = segments.pop() ?? "unnamed";
  const { stem } = splitExtension(filename);
  const extension = extensionFor(mode, format);
  const outputFilename = truncateSegment(stem, extension, "_xmp");
  return boundRelativePath([...segments, outputFilename]);
}

function collisionKey(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
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
  const reserved = new Set(safePaths.map(collisionKey));
  const used = new Set<string>();

  return safePaths.map((path) => {
    const key = collisionKey(path);
    if (!used.has(key)) {
      used.add(key);
      return path;
    }

    let sequence = 2;
    let candidate = withCollisionSuffix(path, sequence);
    while (
      used.has(collisionKey(candidate)) ||
      reserved.has(collisionKey(candidate))
    ) {
      sequence += 1;
      candidate = withCollisionSuffix(path, sequence);
    }
    used.add(collisionKey(candidate));
    return candidate;
  });
}
