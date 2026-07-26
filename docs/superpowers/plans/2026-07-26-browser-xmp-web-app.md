# Browser-Local XMP Web App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the public download landing page with a Netlify-hosted web app that batch-writes and verifies `contains-synthetic-performer` in `XMP dc:subject` entirely inside the browser.

**Architecture:** A Preact/TypeScript UI sends user-selected `File` objects to typed Web Workers. Focused binary modules read and write XMP in JPEG APP1, PNG iTXt, and WebP RIFF containers; PNG, static WebP, and BMP can be decoded and encoded as high-quality JPEG with self-hosted WASM. A batch layer enforces fixed safety limits, isolates per-file failures, and packages successful outputs with a CSV report without making network requests.

**Tech Stack:** Vite 7.3.6, Preact 10.29.7, TypeScript 7.0.2, Vitest 4.1.10, Playwright 1.61.1, `@xmldom/xmldom` 0.9.10, `@jsquash/jpeg` 1.6.0, `client-zip` 2.5.0, Netlify static hosting.

---

## File Map

### Build and deployment

- Modify `package.json` and `package-lock.json` — exact runtime/dev dependencies and scripts.
- Create `tsconfig.json` — strict browser and worker TypeScript settings.
- Replace `vite.config.js` with `vite.config.ts` — Preact, WASM bundling, deterministic build.
- Replace `playwright.config.js` with `playwright.config.ts` — production-build browser tests.
- Create `vitest.config.ts` and `tests/setup.ts` — unit/component environment.
- Create `netlify.toml` — build, publish directory, cache and security headers.
- Replace `.github/workflows/pages.yml` with `.github/workflows/test.yml` — tests only; no Pages deployment.
- Modify `.github/dependabot.yml` — weekly npm and GitHub Actions updates.

### Application shell

- Replace `index.html` — semantic mount point, local-first metadata, no download-first content.
- Replace `src/main.js` with `src/main.tsx` — Preact entry.
- Replace `src/styles.css` — workbench layout, responsive states, accessibility.
- Create `src/app/App.tsx` — application state machine.
- Create `src/app/types.ts` — UI-only state types; processing domain types live in `src/core/types.ts`.
- Create `src/app/components/ModeSelector.tsx`.
- Create `src/app/components/FileDropZone.tsx`.
- Create `src/app/components/BatchPreview.tsx`.
- Create `src/app/components/ProgressPanel.tsx`.
- Create `src/app/components/ResultTable.tsx`.
- Create `src/app/components/DownloadPanel.tsx`.
- Create `src/app/components/HelpSections.tsx`.

### Processing core

- Create `src/core/constants.ts` — tag, namespaces, limits, MIME mappings.
- Create `src/core/errors.ts` — stable error codes and Chinese messages.
- Create `src/core/types.ts` — processing and worker contracts.
- Create `src/core/file-intake.ts` — validation, magic-byte detection, deduplication, relative paths.
- Create `src/core/xmp/model.ts` — safe RDF parsing, normalization, serialization.
- Create `src/core/xmp/jpeg.ts` — JPEG APP1 parser/writer.
- Create `src/core/xmp/png.ts` — PNG iTXt parser/writer and CRC32.
- Create `src/core/xmp/webp.ts` — RIFF/VP8X parser/writer.
- Create `src/core/conversion/bmp.ts` — bounded BMP decoder.
- Create `src/core/conversion/decode.ts` — PNG/WebP decode, orientation, white flatten, sRGB RGBA.
- Create `src/core/conversion/jpeg.ts` — MozJPEG WASM adapter and ICC insertion.
- Create `src/core/process-file.ts` — mode/format behavior and round-trip verification.
- Create `src/core/batch-runner.ts` — scheduling, progress, cancellation, isolation.
- Create `src/core/output/names.ts` — safe names and relative paths.
- Create `src/core/output/csv.ts` — BOM CSV.
- Create `src/core/output/zip.ts` — `client-zip` packaging.

### Worker boundary

- Create `src/worker/protocol.ts` — discriminated request/response messages.
- Create `src/worker/process.worker.ts` — worker command handler.
- Create `src/worker/client.ts` — request IDs, transferables, cancellation by worker replacement.

### Tests and fixtures

- Create focused `tests/unit/**/*.test.ts` files matching every processing module.
- Create `tests/component/App.test.tsx`.
- Replace `tests/site.spec.js` with `tests/e2e/app.spec.ts`.
- Create `tests/e2e/network.spec.ts`.
- Create `tests/e2e/downloads.spec.ts`.
- Create `tests/interop/exiftool.test.mjs`.
- Create `tests/helpers/binary-fixtures.ts`.
- Create committed neutral fixtures under `tests/fixtures/`.
- Replace `tests/content.test.mjs` with `tests/unit/content.test.ts` for Netlify/web-app copy assertions.
- Replace `tests/release-integrity.test.mjs` with `tests/unit/release-integrity.test.ts` for the desktop-fallback release contract.

---

### Task 1: Convert the Site Foundation to Preact and TypeScript

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `tests/setup.ts`
- Create: `src/app/App.tsx`
- Create: `src/app/types.ts`
- Replace: `src/main.js` with `src/main.tsx`
- Replace: `vite.config.js` with `vite.config.ts`
- Test: `tests/unit/foundation.test.ts`

- [ ] **Step 1: Write the failing foundation test**

```ts
// tests/unit/foundation.test.ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("web app foundation", () => {
  it("uses a typed Preact entry and keeps processing dependencies local", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    expect(pkg.dependencies).toMatchObject({
      preact: "10.29.7",
      "@xmldom/xmldom": "0.9.10",
      "@jsquash/jpeg": "1.6.0",
      "client-zip": "2.5.0",
    });
    expect(await readFile("src/main.tsx", "utf8")).toContain("render(<App />");
    expect(await readFile("vite.config.ts", "utf8")).toContain(
      'exclude: ["@jsquash/jpeg"]',
    );
  });
});
```

- [ ] **Step 2: Run the test and verify the red state**

Run: `npm run test:unit -- tests/unit/foundation.test.ts`

Expected: FAIL because `vitest.config.ts` and `src/main.tsx` do not exist.

- [ ] **Step 3: Install exact dependencies and define scripts**

Run:

```bash
npm install --save-exact preact@10.29.7 @xmldom/xmldom@0.9.10 @jsquash/jpeg@1.6.0 client-zip@2.5.0
npm install --save-dev --save-exact typescript@7.0.2 vitest@4.1.10 happy-dom@20.11.0 @preact/preset-vite@2.10.6 @testing-library/preact@3.2.4 @testing-library/user-event@14.6.1 @testing-library/jest-dom@6.9.1
```

Set the scripts to:

```json
{
  "dev": "vite",
  "typecheck": "tsc --noEmit",
  "build": "npm run typecheck && vite build",
  "test:unit": "vitest run",
  "test:e2e": "playwright test",
  "test:interop": "node --test tests/interop/exiftool.test.mjs",
  "test": "npm run test:unit && npm run build && npm run capture:social:check && npm run test:e2e",
  "preview": "vite preview",
  "capture:social": "node scripts/capture-social-card.mjs",
  "capture:social:check": "node scripts/capture-social-card.mjs --check"
}
```

- [ ] **Step 4: Add strict TypeScript and Preact entry**

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker"],
    "jsx": "react-jsx",
    "jsxImportSource": "preact",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noEmit": true,
    "types": ["vite/client", "vitest/globals"]
  },
  "include": ["src", "tests", "*.ts"]
}
```

```ts
// vite.config.ts
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [preact()],
  optimizeDeps: { exclude: ["@jsquash/jpeg"] },
  worker: { format: "es" },
});
```

```tsx
// src/main.tsx
import { render } from "preact";
import { App } from "./app/App";
import "./styles.css";

render(<App />, document.getElementById("app")!);
```

Create the smallest renderable application shell:

```tsx
// src/app/App.tsx
export function App() {
  return (
    <main>
      <h1>AI 图片 XMP 批量处理</h1>
    </main>
  );
}
```

Keep UI state separate from the processing domain:

```ts
// src/app/types.ts
export type AppPhase = "idle" | "ready" | "running" | "stopping" | "complete";

export interface DownloadState {
  hasUndownloadedOutputs: boolean;
  lastDownloadedAt: number | null;
}
```

- [ ] **Step 5: Run the focused tests and typecheck**

Run: `npm run test:unit -- tests/unit/foundation.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts tests/setup.ts tests/unit/foundation.test.ts src/main.tsx src/app/App.tsx src/app/types.ts vite.config.ts
git rm src/main.js vite.config.js
git commit -m "build: add typed browser app foundation"
```

### Task 2: Implement Safe XMP RDF Normalization

**Files:**
- Create: `src/core/constants.ts`
- Create: `src/core/errors.ts`
- Create: `src/core/types.ts`
- Create: `src/core/xmp/model.ts`
- Test: `tests/unit/xmp-model.test.ts`

- [ ] **Step 1: Write failing RDF behavior tests**

```ts
import { describe, expect, it } from "vitest";
import {
  createNormalizedPacket,
  inspectPacket,
} from "../../src/core/xmp/model";

const target = "contains-synthetic-performer";

describe("XMP model", () => {
  it("creates an explicit dc:subject rdf:Bag", () => {
    const packet = createNormalizedPacket(null);
    expect(packet).toContain("<dc:subject>");
    expect(packet).toContain("<rdf:Bag>");
    expect(inspectPacket(packet)).toEqual({
      subjectExists: true,
      subjects: [target],
      targetTagCount: 1,
    });
  });

  it("preserves other keywords and removes target duplicates", () => {
    const packet = createNormalizedPacket(fixturePacket([
      "existing-keyword",
      target,
      target,
    ]));
    expect(inspectPacket(packet).subjects).toEqual([
      "existing-keyword",
      target,
    ]);
  });

  it("preserves unrelated XMP properties while normalizing dc:subject", () => {
    const packet = fixturePacketWithProperties({
      subjects: ["existing-keyword"],
      creatorTool: "fixture-tool",
      rating: "4",
    });
    const normalized = createNormalizedPacket(packet);
    expect(normalized).toContain("fixture-tool");
    expect(normalized).toContain('xmp:Rating="4"');
  });

  it.each(["<!DOCTYPE x [<!ENTITY a 'x'>]><x>&a;</x>", "x".repeat(61_441)])(
    "rejects unsafe or oversized XML",
    (xml) => expect(() => inspectPacket(xml)).toThrow(),
  );
});
```

- [ ] **Step 2: Verify failure**

Run: `npm run test:unit -- tests/unit/xmp-model.test.ts`

Expected: FAIL because the XMP model module does not exist.

- [ ] **Step 3: Define stable types and errors**

```ts
// src/core/types.ts
export type ProcessingMode =
  | "jpeg-and-xmp"
  | "original-and-xmp"
  | "verify-only";

export type ImageFormat = "jpeg" | "png" | "webp" | "bmp";

export interface SubjectCheck {
  subjectExists: boolean;
  subjects: string[];
  targetTagCount: number;
}
```

```ts
// src/core/constants.ts
export const TARGET_SUBJECT = "contains-synthetic-performer";
export const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
export const DC_NS = "http://purl.org/dc/elements/1.1/";
export const XMP_META_NS = "adobe:ns:meta/";
export const MAX_XMP_BYTES = 60 * 1024;
export const MAX_FILES = 300;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_BATCH_BYTES = 500 * 1024 * 1024;
export const MAX_DECODED_PIXELS = 40_000_000;
```

```ts
// src/core/errors.ts
export type ProcessingErrorCode =
  | "UNSUPPORTED_FORMAT"
  | "LIMIT_EXCEEDED"
  | "CORRUPT_CONTAINER"
  | "INVALID_XMP"
  | "XMP_CONFLICT"
  | "EXTENDED_XMP_UNSUPPORTED"
  | "DECODE_FAILED"
  | "ENCODE_FAILED"
  | "VERIFY_FAILED"
  | "CANCELLED";

export class ProcessingError extends Error {
  constructor(
    readonly code: ProcessingErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProcessingError";
  }
}
```

- [ ] **Step 4: Implement namespace-aware parsing and serialization**

Use `@xmldom/xmldom` with a collecting error handler. Measure both input and serialized output with `TextEncoder` and reject packets over `MAX_XMP_BYTES`. Reject `DOCTYPE`, custom entity declarations, unresolved custom entities, parser errors, more than one `dc:subject`, and a non-`rdf:Bag` subject; permit XML's five predefined entities. Preserve all unrelated elements, attributes, namespace declarations, processing instructions, and non-target subject order. When no packet exists, construct:

```xml
<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:subject><rdf:Bag><rdf:li>contains-synthetic-performer</rdf:li></rdf:Bag></dc:subject>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
```

Import `SubjectCheck` from `src/core/types.ts` and export these exact functions:

```ts
export function inspectPacket(xml: string | null): SubjectCheck;
export function createNormalizedPacket(xml: string | null): string;
```

- [ ] **Step 5: Run tests**

Run: `npm run test:unit -- tests/unit/xmp-model.test.ts`

Expected: PASS for absent, existing, duplicate, namespace-prefix variation, malformed, entity, and size cases.

- [ ] **Step 6: Commit**

```bash
git add src/core/constants.ts src/core/errors.ts src/core/types.ts src/core/xmp/model.ts tests/unit/xmp-model.test.ts
git commit -m "feat: add safe XMP subject normalization"
```

### Task 3: Implement Lossless JPEG XMP Writing

**Files:**
- Create: `src/core/xmp/jpeg.ts`
- Test: `tests/unit/jpeg-xmp.test.ts`
- Create: `tests/helpers/binary-fixtures.ts`

- [ ] **Step 1: Write failing JPEG tests**

```ts
describe("JPEG XMP", () => {
  it("inserts one standard APP1 packet without changing scan bytes", () => {
    const input = jpegFixture({ xmp: null, exif: true, icc: true });
    const beforeScan = extractJpegScan(input);
    const output = writeJpegXmp(input, createNormalizedPacket(null));
    expect(extractJpegScan(output)).toEqual(beforeScan);
    expect(readJpegXmp(output)).toContain(TARGET_SUBJECT);
  });

  it("replaces one packet and rejects duplicate or extended packets", () => {
    expect(() => writeJpegXmp(jpegFixture({ duplicateXmp: true }), "<x/>"))
      .toThrowErrorMatchingObject({ code: "XMP_CONFLICT" });
    expect(() => writeJpegXmp(jpegFixture({ extendedXmp: true }), "<x/>"))
      .toThrowErrorMatchingObject({ code: "EXTENDED_XMP_UNSUPPORTED" });
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npm run test:unit -- tests/unit/jpeg-xmp.test.ts`

Expected: FAIL because `jpeg.ts` does not exist.

- [ ] **Step 3: Implement a strict JPEG segment iterator**

Use the exact marker rules:

- Require `FF D8`.
- Before SOS, accept standalone `RST0..RST7`, `TEM`, and `SOI`; all other markers have a big-endian length of at least 2.
- Reject lengths outside the buffer.
- Stop metadata parsing at `FF DA`; preserve everything from SOS through EOI as opaque scan data.
- Recognize standard XMP only when APP1 payload begins with `http://ns.adobe.com/xap/1.0/\0`.
- Recognize Extended XMP by `http://ns.adobe.com/xmp/extension/\0`.

Export:

```ts
export function readJpegXmp(bytes: Uint8Array): string | null;
export function writeJpegXmp(bytes: Uint8Array, packet: string): Uint8Array;
export function extractJpegScan(bytes: Uint8Array): Uint8Array;
```

Insert the new APP1 after contiguous JFIF/Exif/ICC APP0/APP1/APP2 metadata and before the first structural image segment. Enforce the 65,535-byte JPEG segment length.

- [ ] **Step 4: Run corruption and byte-preservation tests**

Run: `npm run test:unit -- tests/unit/jpeg-xmp.test.ts`

Expected: PASS, including truncated length, missing SOS, multiple packets, extended XMP, existing EXIF/ICC, and exact scan-byte equality.

- [ ] **Step 5: Commit**

```bash
git add src/core/xmp/jpeg.ts tests/unit/jpeg-xmp.test.ts tests/helpers/binary-fixtures.ts
git commit -m "feat: write JPEG XMP without re-encoding"
```

### Task 4: Implement PNG XMP iTXt Writing

**Files:**
- Create: `src/core/xmp/png.ts`
- Test: `tests/unit/png-xmp.test.ts`

- [ ] **Step 1: Write failing PNG tests**

```ts
it("adds one uncompressed XML:com.adobe.xmp iTXt before IEND", () => {
  const input = pngFixture({ xmp: null, text: true });
  const output = writePngXmp(input, createNormalizedPacket(null));
  expect(readPngXmp(output)).toContain(TARGET_SUBJECT);
  expect(listPngChunks(output).filter((chunk) => chunk.type === "iTXt"))
    .toHaveLength(2);
  expect(validateEveryPngCrc(output)).toBe(true);
});

it("preserves every non-XMP chunk byte-for-byte", () => {
  const input = pngFixture({ xmp: fixturePacket(["old"]) });
  const output = writePngXmp(input, createNormalizedPacket(readPngXmp(input)));
  expect(nonXmpPngChunks(output)).toEqual(nonXmpPngChunks(input));
});
```

- [ ] **Step 2: Verify failure**

Run: `npm run test:unit -- tests/unit/png-xmp.test.ts`

Expected: FAIL because `png.ts` is missing.

- [ ] **Step 3: Implement validated chunks and CRC32**

Export:

```ts
export interface PngChunk { type: string; raw: Uint8Array; data: Uint8Array }
export function listPngChunks(bytes: Uint8Array): PngChunk[];
export function readPngXmp(bytes: Uint8Array): string | null;
export function writePngXmp(bytes: Uint8Array, packet: string): Uint8Array;
export function crc32(bytes: Uint8Array): number;
```

Require the eight-byte PNG signature, one IHDR first, one IEND last, complete chunk boundaries, and valid CRC for every input chunk. An XMP iTXt payload is:

```text
XML:com.adobe.xmp\0  compression-flag=0  compression-method=0
language-tag=\0  translated-keyword=\0  UTF-8-XMP-packet
```

Replace one XMP chunk in place; insert before IEND when absent; reject more than one.

- [ ] **Step 4: Run tests**

Run: `npm run test:unit -- tests/unit/png-xmp.test.ts`

Expected: PASS for insert, replace, other text preservation, duplicate XMP, bad CRC, and truncated chunk.

- [ ] **Step 5: Commit**

```bash
git add src/core/xmp/png.ts tests/unit/png-xmp.test.ts
git commit -m "feat: add PNG XMP container support"
```

### Task 5: Implement WebP RIFF XMP Writing

**Files:**
- Create: `src/core/xmp/webp.ts`
- Test: `tests/unit/webp-xmp.test.ts`

- [ ] **Step 1: Write failing WebP tests**

```ts
it.each(["VP8 ", "VP8L", "VP8X"])(
  "writes one XMP chunk into %s WebP",
  (kind) => {
    const input = webpFixture({ kind, xmp: null });
    const output = writeWebpXmp(input, createNormalizedPacket(null));
    expect(readWebpXmp(output)).toContain(TARGET_SUBJECT);
    expect(readRiffSize(output)).toBe(output.byteLength - 8);
    expect(readVp8xFlags(output) & 0b0000_0100).toBe(0b0000_0100);
  },
);

it("preserves animation, EXIF, ICC and unknown chunks", () => {
  const input = webpFixture({ kind: "VP8X", animated: true, metadata: true });
  const output = writeWebpXmp(input, createNormalizedPacket(null));
  expect(nonXmpWebpChunks(output)).toEqual(nonXmpWebpChunks(input, {
    ignoreVp8xFlags: true,
  }));
});
```

- [ ] **Step 2: Verify failure**

Run: `npm run test:unit -- tests/unit/webp-xmp.test.ts`

Expected: FAIL because `webp.ts` is missing.

- [ ] **Step 3: Implement RIFF parsing and VP8X synthesis**

Export:

```ts
export interface WebpChunk { fourcc: string; data: Uint8Array; raw: Uint8Array }
export function listWebpChunks(bytes: Uint8Array): WebpChunk[];
export function readWebpXmp(bytes: Uint8Array): string | null;
export function writeWebpXmp(bytes: Uint8Array, packet: string): Uint8Array;
export function isAnimatedWebp(bytes: Uint8Array): boolean;
```

Rules:

- Require ASCII `RIFF`, little-endian size equal to file length minus 8, and ASCII `WEBP`.
- Respect even-byte RIFF padding and reject truncated chunks.
- Reject multiple `XMP ` chunks.
- For existing VP8X, set bit `0x04`.
- For simple VP8/VP8L, parse validated canvas dimensions, prepend a ten-byte VP8X payload with XMP flag and 24-bit `width-1`/`height-1`.
- Place `XMP ` after image/animation chunks and before trailing unknown metadata only when the official order requires it; keep all unaffected chunks byte-identical.

- [ ] **Step 4: Run tests**

Run: `npm run test:unit -- tests/unit/webp-xmp.test.ts`

Expected: PASS for VP8, VP8L, VP8X, animated, odd padding, duplicate XMP, bad RIFF size, truncated and dimension overflow cases.

- [ ] **Step 5: Commit**

```bash
git add src/core/xmp/webp.ts tests/unit/webp-xmp.test.ts
git commit -m "feat: add WebP XMP container support"
```

### Task 6: Add File Intake, Format Detection, and Batch Limits

**Files:**
- Create: `src/core/file-intake.ts`
- Test: `tests/unit/file-intake.test.ts`

- [ ] **Step 1: Write failing intake tests**

```ts
it("detects format from magic bytes instead of extension", async () => {
  const file = new File([pngFixture({})], "wrong.jpg");
  await expect(inspectSelectedFile(file, "")).resolves.toMatchObject({
    format: "png",
    warning: "扩展名与文件内容不一致",
  });
});

it("deduplicates and enforces hard limits", async () => {
  expect(() => applyBatchPolicy(makeFiles(301))).toThrowErrorMatchingObject({
    code: "LIMIT_EXCEEDED",
  });
  expect(() => applyBatchPolicy(makeFiles(2, 251 * 1024 * 1024)))
    .toThrowErrorMatchingObject({ code: "LIMIT_EXCEEDED" });
});
```

- [ ] **Step 2: Verify failure**

Run: `npm run test:unit -- tests/unit/file-intake.test.ts`

Expected: FAIL because `file-intake.ts` is missing.

- [ ] **Step 3: Implement intake contracts**

```ts
export interface SelectedImage {
  id: string;
  file: File;
  format: ImageFormat;
  relativePath: string;
  warning: string | null;
}

export async function inspectSelectedFile(
  file: File,
  relativePath: string,
): Promise<SelectedImage>;
export function mergeSelectedImages(
  current: SelectedImage[],
  incoming: SelectedImage[],
): SelectedImage[];
export function applyBatchPolicy(files: SelectedImage[]): {
  totalBytes: number;
  warning: string | null;
};
```

Import `ImageFormat` from `src/core/types.ts`; do not redeclare the format union in this module.

Read only the first 32 bytes for magic detection. Define duplicate identity as the tuple `(relativePath, file.name, file.size, file.lastModified)` and keep the first occurrence. Reject unsupported magic, zero-byte files, files over 50 MB, more than 300 files, and batches over 500 MB. Warn over 100 files or 250 MB.

- [ ] **Step 4: Run tests**

Run: `npm run test:unit -- tests/unit/file-intake.test.ts`

Expected: PASS for extension mismatch, duplicate identity, folder paths, zero bytes, individual and batch limits.

- [ ] **Step 5: Commit**

```bash
git add src/core/file-intake.ts tests/unit/file-intake.test.ts
git commit -m "feat: validate local image batches"
```

### Task 7: Implement BMP Decode and High-Quality JPEG Conversion

**Files:**
- Create: `src/core/conversion/bmp.ts`
- Create: `src/core/conversion/decode.ts`
- Create: `src/core/conversion/jpeg.ts`
- Create: `src/assets/srgb.icc`
- Test: `tests/unit/bmp.test.ts`
- Test: `tests/e2e/conversion.spec.ts`

- [ ] **Step 1: Write failing BMP boundary tests**

Cover 1/4/8/16/24/32-bit BI_RGB, RLE4, RLE8, top-down, bottom-up, explicit alpha mask, invalid DIB, bad offsets, truncated pixels, and 40,000,001 pixels. Assert returned RGBA order and white alpha flatten behavior.

- [ ] **Step 2: Verify failure**

Run: `npm run test:unit -- tests/unit/bmp.test.ts`

Expected: FAIL because the decoder is missing.

- [ ] **Step 3: Port the bounded desktop BMP algorithm as a pure buffer function**

```ts
export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export function decodeBmp(bytes: Uint8Array): RgbaImage;
```

Do not import Node, Sharp, `bmp-js`, canvas, or filesystem APIs. Validate every multiplication before allocation and use `MAX_DECODED_PIXELS`.

- [ ] **Step 4: Implement browser decode and MozJPEG encode adapters**

```ts
export async function decodeRaster(
  file: File,
  format: "png" | "webp" | "bmp",
): Promise<RgbaImage>;

export async function encodeHighQualityJpeg(
  image: RgbaImage,
): Promise<Uint8Array>;
```

PNG/WebP use `createImageBitmap(file, { imageOrientation: "from-image", colorSpaceConversion: "default", premultiplyAlpha: "none" })`, an `OffscreenCanvas`, and white compositing. BMP uses `decodeBmp`. Reject animated WebP before decoding.

Call `@jsquash/jpeg/encode` with:

```ts
{
  quality: 100,
  baseline: true,
  progressive: false,
  auto_subsample: false,
  chroma_subsample: 1,
  separate_chroma_quality: true,
  chroma_quality: 100,
}
```

Insert the committed standard sRGB ICC profile as correctly numbered JPEG APP2 `ICC_PROFILE\0` segments before XMP writing.

- [ ] **Step 5: Add browser conversion fixtures and assertions**

Run: `npm run test:e2e -- tests/e2e/conversion.spec.ts`

Expected: PASS for dimensions, orientation, white background, ICC presence, non-progressive SOF marker, and 4:4:4 sampling factors.

- [ ] **Step 6: Commit**

```bash
git add src/core/conversion src/assets/srgb.icc tests/unit/bmp.test.ts tests/e2e/conversion.spec.ts tests/fixtures
git commit -m "feat: convert browser images to high-quality JPEG"
```

### Task 8: Implement the Three Processing Modes with Round-Trip Verification

**Files:**
- Create: `src/core/process-file.ts`
- Test: `tests/unit/process-file.test.ts`

- [ ] **Step 1: Write the mode matrix tests**

Use a table covering every `(mode, format)` pair:

```ts
const cases = [
  ["jpeg-and-xmp", "jpeg", "jpeg", false, "success"],
  ["jpeg-and-xmp", "png", "jpeg", true, "success"],
  ["jpeg-and-xmp", "webp", "jpeg", true, "success"],
  ["jpeg-and-xmp", "bmp", "jpeg", true, "success"],
  ["original-and-xmp", "jpeg", "jpeg", false, "success"],
  ["original-and-xmp", "png", "png", false, "success"],
  ["original-and-xmp", "webp", "webp", false, "success"],
  ["original-and-xmp", "bmp", null, false, "failed"],
  ["verify-only", "jpeg", null, false, "checked"],
  ["verify-only", "png", null, false, "checked"],
  ["verify-only", "webp", null, false, "checked"],
  ["verify-only", "bmp", null, false, "failed"],
] as const;
```

Assert target count is exactly one after every successful write. Verify-only must never return output bytes.

- [ ] **Step 2: Verify failure**

Run: `npm run test:unit -- tests/unit/process-file.test.ts`

Expected: FAIL because `process-file.ts` is missing.

- [ ] **Step 3: Implement explicit format routing**

```ts
export interface ProcessRequest {
  id: string;
  file: File;
  format: ImageFormat;
  relativePath: string;
  mode: ProcessingMode;
}

export interface ProcessResult {
  id: string;
  state: "success" | "checked" | "failed" | "cancelled";
  output: Blob | null;
  outputFormat: ImageFormat | null;
  outputName: string | null;
  subjectExists: boolean;
  targetTagCount: number;
  reencoded: boolean;
  message: string;
  elapsedMs: number;
}

export async function processFile(request: ProcessRequest): Promise<ProcessResult>;
```

For converted outputs, extract only existing subject keywords from supported input XMP, generate a minimal packet, encode JPEG, write XMP, and re-read. For original-format writes, normalize the existing packet. Map `ProcessingError` codes to the approved actionable Chinese text.

- [ ] **Step 4: Run tests**

Run: `npm run test:unit -- tests/unit/process-file.test.ts`

Expected: PASS for the entire matrix, duplicate normalization, animated WebP conversion refusal, corrupt input, and verification mismatch injection.

- [ ] **Step 5: Commit**

```bash
git add src/core/process-file.ts tests/unit/process-file.test.ts
git commit -m "feat: process images in three XMP modes"
```

### Task 9: Add the Worker Protocol, Batch Scheduler, Progress, and Cancellation

**Files:**
- Create: `src/worker/protocol.ts`
- Create: `src/worker/process.worker.ts`
- Create: `src/worker/client.ts`
- Create: `src/core/batch-runner.ts`
- Test: `tests/unit/batch-runner.test.ts`

- [ ] **Step 1: Write failing scheduler tests**

Use fake worker clients to prove:

- conversion concurrency never exceeds one;
- metadata-only concurrency never exceeds two;
- one rejected file becomes one failed result and later files continue;
- cancel marks queued work cancelled and terminates in-flight workers;
- progress counts always sum to completed.

- [ ] **Step 2: Verify failure**

Run: `npm run test:unit -- tests/unit/batch-runner.test.ts`

Expected: FAIL because the scheduler is missing.

- [ ] **Step 3: Define a discriminated worker protocol**

```ts
export type WorkerRequest =
  | { type: "process"; requestId: string; payload: ProcessRequest }
  | { type: "ping"; requestId: string };

export type WorkerResponse =
  | { type: "result"; requestId: string; payload: ProcessResult }
  | {
      type: "error";
      requestId: string;
      error: { code: ProcessingErrorCode; message: string };
    }
  | { type: "pong"; requestId: string };
```

`File` and `Blob` are structured-cloneable, so the protocol sends `ProcessRequest` and `ProcessResult` directly. `WorkerClient.cancelAll()` must terminate and replace its worker, reject pending promises with `CANCELLED`, and attach only one message/error listener to each replacement.

- [ ] **Step 4: Implement the scheduler**

```ts
export interface BatchProgress {
  total: number;
  completed: number;
  success: number;
  checked: number;
  failed: number;
  cancelled: number;
  current: ProcessResult | null;
}

export class BatchRunner {
  run(
    requests: ProcessRequest[],
    onProgress: (progress: BatchProgress) => void,
  ): Promise<ProcessResult[]>;
  cancel(): void;
}
```

Classify PNG/WebP/BMP conversion requests into a single conversion lane; put JPEG metadata work, original writes, and verification into a two-worker metadata lane. Preserve input result order.

- [ ] **Step 5: Run tests**

Run: `npm run test:unit -- tests/unit/batch-runner.test.ts`

Expected: PASS with fake timers and deferred promises.

- [ ] **Step 6: Commit**

```bash
git add src/worker src/core/batch-runner.ts tests/unit/batch-runner.test.ts
git commit -m "feat: run cancellable browser XMP batches"
```

### Task 10: Add Safe Names, CSV, and ZIP Packaging

**Files:**
- Create: `src/core/output/names.ts`
- Create: `src/core/output/csv.ts`
- Create: `src/core/output/zip.ts`
- Test: `tests/unit/output.test.ts`

- [ ] **Step 1: Write failing output tests**

```ts
it.each([
  ["../../secret.jpg", "jpeg", "secret_xmp.jpg"],
  ["C:\\Users\\A\\CON.jpg", "jpeg", "CON-file_xmp.jpg"],
  ["a\u0000b.png", "png", "ab_xmp.png"],
])("sanitizes %s", (input, format, expected) => {
  expect(planOutputName(input, "original-and-xmp", format)).toBe(expected);
});

it("keeps only relative paths in the BOM CSV", () => {
  const csv = createCsv([result({ relativePath: "folder/a.jpg" })]);
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  expect(csv).toContain("folder/a.jpg");
  expect(csv).not.toMatch(/\/Users\/|[A-Z]:\\/);
});
```

Erratum: `format` is the detected, actual output format, and the planned
extension must follow it rather than an untrusted source filename extension.

- [ ] **Step 2: Verify failure**

Run: `npm run test:unit -- tests/unit/output.test.ts`

Expected: FAIL because output modules are missing.

- [ ] **Step 3: Implement deterministic safe paths**

Export:

```ts
export function sanitizeRelativePath(path: string): string;
export function planOutputName(
  path: string,
  mode: ProcessingMode,
  format: ImageFormat,
): string;
export function resolveNameCollisions(paths: string[]): string[];
export function createCsv(results: ProcessResult[]): string;
export async function createOutputZip(
  results: ProcessResult[],
  now: Date,
): Promise<{ filename: string; blob: Blob }>;
```

Use `client-zip` with stored image entries because images are already compressed. ZIP root is `AI_XMP_Output/`; add `processing-report.csv`. Strip drives, leading separators, `.`/`..`, controls, trailing dots/spaces, and protect `CON|PRN|AUX|NUL|COM1..9|LPT1..9`.

- [ ] **Step 4: Run output tests**

Run: `npm run test:unit -- tests/unit/output.test.ts`

Expected: PASS, including UTF-8 Chinese names, collision suffixes, Zip Slip paths, CSV quote escaping, and empty-success handling.

- [ ] **Step 5: Commit**

```bash
git add src/core/output tests/unit/output.test.ts
git commit -m "feat: package safe browser processing outputs"
```

### Task 11: Build the Accessible Single-Page Workbench

**Files:**
- Replace: `index.html`
- Replace: `src/app/App.tsx`
- Create: `src/app/components/ModeSelector.tsx`
- Create: `src/app/components/FileDropZone.tsx`
- Create: `src/app/components/BatchPreview.tsx`
- Create: `src/app/components/ProgressPanel.tsx`
- Create: `src/app/components/ResultTable.tsx`
- Create: `src/app/components/DownloadPanel.tsx`
- Create: `src/app/components/HelpSections.tsx`
- Replace: `src/styles.css`
- Test: `tests/component/App.test.tsx`

- [ ] **Step 1: Write failing user-flow component tests**

```tsx
it("defaults to high-quality JPEG and explains local-only processing", () => {
  render(<App dependencies={fakeDependencies()} />);
  expect(screen.getByRole("radio", { name: /高清 JPG/ })).toBeChecked();
  expect(screen.getByText(/图片只在当前浏览器处理/)).toBeVisible();
  expect(screen.getByRole("button", { name: "开始处理" })).toBeDisabled();
});

it("adds files, runs a partial-success batch, and offers ZIP plus CSV", async () => {
  const user = userEvent.setup();
  render(<App dependencies={fakeDependencies({ success: 2, failed: 1 })} />);
  await user.upload(screen.getByLabelText("选择图片"), selectedFiles());
  await user.click(screen.getByRole("button", { name: "开始处理" }));
  expect(await screen.findByText("成功 2")).toBeVisible();
  expect(screen.getByRole("button", { name: /下载处理结果 ZIP/ })).toBeEnabled();
  expect(screen.getByRole("button", { name: /下载 CSV 报告/ })).toBeEnabled();
});
```

- [ ] **Step 2: Verify failure**

Run: `npm run test:unit -- tests/component/App.test.tsx`

Expected: FAIL because the workbench components are missing.

- [ ] **Step 3: Implement an explicit UI state machine**

Use phases `idle | ready | running | stopping | complete`. Lock mode and intake while running. Keep the following dependency boundary so component tests do not create real workers:

```ts
export interface AppDependencies {
  inspectFiles(files: File[]): Promise<SelectedImage[]>;
  runBatch(
    requests: ProcessRequest[],
    onProgress: (progress: BatchProgress) => void,
  ): Promise<ProcessResult[]>;
  cancelBatch(): void;
  download(blob: Blob, filename: string): void;
}
```

Add `beforeunload` only while successful undownloaded outputs exist, and remove it after download or new batch.

- [ ] **Step 4: Implement semantic components and responsive styling**

Required contracts:

- modes are a `<fieldset>` with three radios;
- drop zone is keyboard activatable and backed by visible file/folder buttons;
- progress uses `<progress>` and an `aria-live="polite"` summary;
- result table has real column headers and a card fallback below 720px;
- errors use an assertive live region;
- focus moves to results heading on completion;
- color is never the only state signal;
- motion respects `prefers-reduced-motion`.

- [ ] **Step 5: Run component tests and accessibility checks**

Run: `npm run test:unit -- tests/component/App.test.tsx`

Expected: PASS for intake, mode lock, warning/hard limits, progress, cancel, partial failure, single download, ZIP, CSV, new batch, focus, and keyboard behavior.

- [ ] **Step 6: Commit**

```bash
git add index.html src/app src/styles.css tests/component/App.test.tsx
git commit -m "feat: add browser-local XMP workbench"
```

### Task 12: Replace the Download-Site Copy with Product Guidance and Netlify Configuration

**Files:**
- Modify: `README.md`
- Modify: `RELEASE.md`
- Create: `netlify.toml`
- Delete: `.github/workflows/pages.yml`
- Create: `.github/workflows/test.yml`
- Modify: `.github/dependabot.yml`
- Replace: `tests/content.test.mjs` with `tests/unit/content.test.ts`
- Replace: `tests/release-integrity.test.mjs` with `tests/unit/release-integrity.test.ts`
- Delete: `release-build.mjs`
- Delete: `release-manifest.mjs`
- Delete: `scripts/assert-release-assets.mjs`
- Delete: `scripts/test-ci-repository.mjs`
- Retain: `release.json`, `social-card.html`, `social-card.lock.json`, and `scripts/capture-social-card.mjs`

- [ ] **Step 1: Rewrite content tests first**

Assert:

- primary heading says direct browser processing;
- local-only/privacy wording is present;
- all three modes and exact format matrix are present;
- batch limits are 300 files, 50 MB each, 500 MB total, 40 MP conversion;
- no analytics, upload endpoint, remote fonts, third-party runtime script, or Pages wording;
- Netlify config uses `npm run build`, `dist`, Node 24, and required headers;
- the desktop release appears only as a fallback for HEIC/TIFF/large batches.

- [ ] **Step 2: Verify failure**

Run: `npm run test:unit -- tests/unit/content.test.ts tests/unit/release-integrity.test.ts`

Expected: FAIL on legacy download-page and GitHub Pages assertions.

- [ ] **Step 3: Add exact Netlify config**

```toml
[build]
  command = "npm run build"
  publish = "dist"

[build.environment]
  NODE_VERSION = "24"

[[headers]]
  for = "/*"
  [headers.values]
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "no-referrer"
    Permissions-Policy = "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
    Content-Security-Policy = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'none'; font-src 'self'; media-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'"

[[headers]]
  for = "/assets/*"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"

[[headers]]
  for = "/*.html"
  [headers.values]
    Cache-Control = "public, max-age=0, must-revalidate"
```

- [ ] **Step 4: Rewrite README and help copy**

Document supported modes/formats, exact limits, local-only behavior, conversion metadata stripping, current browser requirement, Netlify preview/deploy commands, and independent ExifTool verification. Keep the independent-product disclaimer.

- [ ] **Step 5: Remove Pages and obsolete download-only machinery**

Delete `.github/workflows/pages.yml`, `release-build.mjs`, `release-manifest.mjs`, `scripts/assert-release-assets.mjs`, and `scripts/test-ci-repository.mjs`. Remove the legacy `test:content`, `test:release`, and `test:ci-repository` package scripts because the two replacement Vitest files run through `test:unit`. Create `.github/workflows/test.yml` with pinned checkout/setup-node actions, `npm ci`, `npm test`, and artifact upload only for failed Playwright reports. Task 13 adds the independent ExifTool CI gate when its test file exists, so this intermediate workflow never references a missing test.

Retain `release.json` as the version/checksum source for the secondary desktop-app fallback. Retain `social-card.html`, `social-card.lock.json`, `scripts/capture-social-card.mjs`, `capture:social`, and `capture:social:check`; update their copy and screenshot assertions from “download the app” to “process images in the browser.”

- [ ] **Step 6: Run tests**

Run: `npm run test:unit && npm run build`

Expected: PASS with no `github.io`, Pages workflow, unresolved tokens, external runtime assets, or CSP violations in the built HTML.

- [ ] **Step 7: Commit**

```bash
git add README.md RELEASE.md netlify.toml .github/dependabot.yml .github/workflows/test.yml package.json package-lock.json release.json social-card.html social-card.lock.json scripts/capture-social-card.mjs tests/unit/content.test.ts tests/unit/release-integrity.test.ts
git rm .github/workflows/pages.yml release-build.mjs release-manifest.mjs scripts/assert-release-assets.mjs scripts/test-ci-repository.mjs tests/content.test.mjs tests/release-integrity.test.mjs
git commit -m "docs: publish browser-local Netlify guidance"
```

### Task 13: Add End-to-End Downloads, Privacy, and Independent ExifTool Interop

**Files:**
- Replace: `playwright.config.js` with `playwright.config.ts`
- Create: `tests/e2e/app.spec.ts`
- Create: `tests/e2e/network.spec.ts`
- Create: `tests/e2e/downloads.spec.ts`
- Create: `tests/interop/exiftool.test.mjs`
- Create: `tests/fixtures/README.md`
- Create: `tests/fixtures/*`

- [ ] **Step 1: Configure production-build E2E**

```ts
export default defineConfig({
  testDir: "./tests/e2e",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: devices["Desktop Chrome"] }],
  webServer: {
    command: "npm run build && npm run preview -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
});
```

- [ ] **Step 2: Write failing complete-flow tests**

Use `setInputFiles` with committed neutral fixtures. Assert:

- three modes produce the expected result states;
- JPEG default output retains identical scan SHA-256;
- a two-success/one-failure batch still produces a ZIP;
- ZIP names and CSV contain no absolute paths;
- cancel stops queued work;
- reload warning is active only for undownloaded results.

- [ ] **Step 3: Add the no-upload network test**

After initial page load, start request recording, process fixtures, and assert every request list is empty. Also assert `fetch`, `XMLHttpRequest`, `sendBeacon`, and WebSocket are not called by application code.

- [ ] **Step 4: Add independent ExifTool verification**

The Node interop test must:

1. Check `exiftool -ver`; skip locally with an explicit message only when unavailable.
2. Use Playwright to generate JPEG, PNG, and WebP outputs.
3. Save downloads in a temporary directory.
4. Run:

```bash
exiftool -json -G1 -XMP-dc:Subject output-file
```

5. Assert `[XMP-dc]Subject` contains exactly one `contains-synthetic-performer`.
6. Assert original JPEG scan SHA-256 remains unchanged.

In GitHub Actions, install the Ubuntu `libimage-exiftool-perl` package before `npm run test:interop`; CI must not skip.

- [ ] **Step 5: Run full local verification**

Run:

```bash
npm ci
npm run test
npm run test:interop
```

Expected: all unit, component, build, browser and ExifTool tests pass; the only permitted local interop outcome is an explicit skip when ExifTool is absent.

- [ ] **Step 6: Commit**

```bash
git add playwright.config.ts tests/e2e tests/interop tests/fixtures .github/workflows/test.yml
git rm playwright.config.js
git commit -m "test: verify browser outputs and local-only privacy"
```

### Task 14: Final Cross-Platform QA and Netlify Production Deployment

**Files:**
- Modify only if QA finds a concrete defect.
- Update: `README.md` with the final production URL.

- [ ] **Step 1: Run the complete clean-room suite**

Run:

```bash
git status --short
npm ci
npm run test
npm run test:interop
npm audit --audit-level=high
git diff --check
```

Expected: clean start, all tests pass, zero high/critical vulnerabilities, no diff errors.

- [ ] **Step 2: Audit public boundaries**

Run targeted scans that fail on:

- `/Users/`, Windows absolute user paths, private repository paths;
- `.dmg`, `.exe`, `.app`, signing keys, tokens;
- `shp-ca-cid`, Seller Central session URLs;
- analytics/telemetry/upload endpoints;
- remote fonts/scripts/WASM;
- customer or product images in fixtures/screenshots.

Expected: no prohibited public content.

- [ ] **Step 3: Perform real-browser QA**

On Mac Chrome and Safari, and Windows Edge and Chrome:

- process one JPG, PNG, WebP and BMP in the default mode;
- write original-format JPG, PNG and WebP;
- verify-only all three containers;
- process a folder with nested names and Chinese characters;
- verify outputs with ExifTool;
- confirm no request appears after processing begins;
- confirm ZIP and CSV open normally.

Windows and Safari results are release blockers; do not claim support without a real-device pass.

- [ ] **Step 4: Deploy to Netlify**

Preferred: connect the public GitHub repository, production branch `main`, with `netlify.toml` controlling build and publish settings. Fallback: build locally and manually deploy the exact `dist` directory. Do not upload source folders or desktop installers to Netlify.

- [ ] **Step 5: Verify production**

Check:

- HTTPS Netlify URL loads with zero console errors;
- CSP and cache headers match `netlify.toml`;
- WASM loads from the same origin;
- all three modes work on production;
- no image bytes are transmitted;
- direct reload and social metadata work;
- Netlify deploy is tied to the reviewed commit.

- [ ] **Step 6: Record the production URL and commit**

```bash
git add README.md
git commit -m "docs: record Netlify production site"
git push origin main
```

Expected: public repository `main` and Netlify production point to the same final commit.
