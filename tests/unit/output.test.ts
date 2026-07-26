import { describe, expect, test } from "vitest";

import {
  planOutputName,
  resolveNameCollisions,
  sanitizeRelativePath,
} from "../../src/core/output/names";
import { createCsv } from "../../src/core/output/csv";
import { createOutputZip } from "../../src/core/output/zip";
import type { ProcessResult } from "../../src/core/process-file";

type ReportableResult = ProcessResult & { relativePath?: string };

function result(
  overrides: Partial<ReportableResult> = {},
): ReportableResult {
  return {
    id: "file-1",
    state: "success",
    output: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], {
      type: "image/jpeg",
    }),
    outputFormat: "jpeg",
    outputName: "image_xmp.jpg",
    subjectExists: true,
    targetTagCount: 1,
    reencoded: false,
    message: "处理成功",
    elapsedMs: 12.4,
    ...overrides,
  };
}

interface ZipEntry {
  name: string;
  method: number;
  crc32: number;
  dosTime: number;
  dosDate: number;
  bytes: Uint8Array;
}

function readUint32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (readUint32(view, offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error("ZIP end-of-central-directory record not found");
}

/**
 * Independent, deliberately small ZIP reader for the store-only archives
 * produced in these tests. It reads the central directory and then the local
 * headers; it does not share any code with the production ZIP implementation.
 */
async function unzipStored(blob: Blob): Promise<ZipEntry[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  const eocd = findEndOfCentralDirectory(bytes);
  const entryCount = view.getUint16(eocd + 10, true);
  let centralOffset = readUint32(view, eocd + 16);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];

  for (let index = 0; index < entryCount; index += 1) {
    expect(readUint32(view, centralOffset)).toBe(0x02014b50);
    const method = view.getUint16(centralOffset + 10, true);
    const crc32 = readUint32(view, centralOffset + 16);
    const compressedSize = readUint32(view, centralOffset + 20);
    const nameLength = view.getUint16(centralOffset + 28, true);
    const extraLength = view.getUint16(centralOffset + 30, true);
    const commentLength = view.getUint16(centralOffset + 32, true);
    const localOffset = readUint32(view, centralOffset + 42);
    const name = decoder.decode(
      bytes.subarray(
        centralOffset + 46,
        centralOffset + 46 + nameLength,
      ),
    );

    expect(readUint32(view, localOffset)).toBe(0x04034b50);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset =
      localOffset + 30 + localNameLength + localExtraLength;
    entries.push({
      name,
      method,
      crc32,
      dosTime: view.getUint16(localOffset + 10, true),
      dosDate: view.getUint16(localOffset + 12, true),
      bytes: bytes.slice(dataOffset, dataOffset + compressedSize),
    });

    centralOffset +=
      46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe("safe output names", () => {
  test("strips traversal and always plans a non-overwriting _xmp name", () => {
    expect(sanitizeRelativePath("../../secret.jpg")).toBe("secret.jpg");
    expect(
      planOutputName(
        "../../secret.jpg",
        "jpeg-and-xmp",
        "jpeg",
      ),
    ).toBe("secret_xmp.jpg");
  });

  test("strips drive roots and protects Windows reserved basenames", () => {
    expect(
      sanitizeRelativePath(String.raw`C:\Users\A\CON.jpg`),
    ).toBe("CON-file.jpg");
    expect(
      planOutputName(
        String.raw`C:\Users\A\CON.jpg`,
        "original-and-xmp",
        "jpeg",
      ),
    ).toBe("CON-file_xmp.jpg");

    for (const reserved of [
      "con",
      "PRN.txt",
      "Aux.",
      "NUL ",
      "CLOCK$",
      "com1.jpeg",
      "CON.foo.bar",
      "COM¹.jpg",
      "com²",
      "LPT³.png",
      "COM9",
      "lpt1.png",
      "LPT9",
    ]) {
      expect(sanitizeRelativePath(reserved)).toMatch(/-file(?:\.|$)/i);
    }
  });

  test("removes NUL and path-confusing controls without harming Chinese", () => {
    expect(
      planOutputName(
        "a\u0000b.png",
        "original-and-xmp",
        "png",
      ),
    ).toBe("ab_xmp.png");
    expect(
      sanitizeRelativePath("商品图/粉色梳妆台.png"),
    ).toBe("商品图/粉色梳妆台.png");
    expect(
      sanitizeRelativePath("safe/\u202Eevil. /\u0001"),
    ).toBe("safe/evil/unnamed");
  });

  test("strips UNC and device roots and never returns an unsafe path", () => {
    expect(
      sanitizeRelativePath(
        String.raw`\\server\share\目录\图片.jpg`,
      ),
    ).toBe("图片.jpg");
    expect(
      sanitizeRelativePath(
        String.raw`\\?\C:\safe\photo.png`,
      ),
    ).toBe("photo.png");
    expect(
      sanitizeRelativePath(
        String.raw`\\?\UNC\server\share\safe\photo.png`,
      ),
    ).toBe("photo.png");

    const sanitized = sanitizeRelativePath(
      String.raw`\\.\C:\..\safe\\.\photo?.jpg`,
    );
    expect(sanitized).toBe("photo.jpg");
    expect(sanitized).not.toMatch(
      /(?:^\/|^[a-z]:|\\|(?:^|\/)\.\.(?:\/|$))/i,
    );
  });

  test("uses deterministic unnamed fallbacks and bounded UTF-8 paths", () => {
    expect(sanitizeRelativePath("\u0000\u0001\u202E")).toBe(
      "unnamed",
    );
    const long = `${"目录/".repeat(150)}${"图".repeat(200)}.jpg`;
    const sanitized = sanitizeRelativePath(long);
    const encoder = new TextEncoder();
    const segments = sanitized.split("/");
    expect(encoder.encode(sanitized).byteLength).toBeLessThanOrEqual(
      512,
    );
    expect(
      Math.max(
        ...segments.map(
          (segment) => encoder.encode(segment).byteLength,
        ),
      ),
    ).toBeLessThanOrEqual(120);
    expect(sanitized).toMatch(/\.jpg$/);
    expect(sanitized).not.toContain("\uFFFD");
  });

  test("normalizes ill-formed Unicode before encoding and collision checks", () => {
    expect(sanitizeRelativePath("bad\uD800.jpg")).toBe(
      "bad\uFFFD.jpg",
    );
    expect(
      resolveNameCollisions([
        "Σ_xmp.jpg",
        "ς_xmp.jpg",
        "\uD800_xmp.jpg",
        "\uFFFD_xmp.jpg",
      ]),
    ).toEqual([
      "Σ_xmp.jpg",
      "ς_xmp-2.jpg",
      "\uFFFD_xmp.jpg",
      "\uFFFD_xmp-2.jpg",
    ]);
  });

  test("uses deterministic extensions for all processing modes", () => {
    expect(
      planOutputName("folder/source.jpg", "jpeg-and-xmp", "png"),
    ).toBe("folder/source_xmp.png");
    expect(
      planOutputName("folder/source.jpg", "original-and-xmp", "png"),
    ).toBe("folder/source_xmp.png");
    expect(
      planOutputName("folder/source", "original-and-xmp", "png"),
    ).toBe("folder/source_xmp.png");
    expect(
      planOutputName("folder/source.jpeg", "verify-only", "jpeg"),
    ).toBe("folder/source_xmp.jpg");
  });

  test("resolves case-insensitive collisions with stable suffixes", () => {
    expect(
      resolveNameCollisions([
        "a/photo_xmp.jpg",
        "A/PHOTO_xmp.jpg",
      ]),
    ).toEqual([
      "a/photo_xmp.jpg",
      "A/PHOTO_xmp-2.jpg",
    ]);

    const resolved = resolveNameCollisions([
      "a/photo_xmp.jpg",
      "A/PHOTO_xmp.jpg",
      "a/photo_xmp-2.jpg",
      "a/photo_xmp.jpg",
    ]);
    expect(resolved).toEqual([
      "a/photo_xmp.jpg",
      "A/PHOTO_xmp-3.jpg",
      "a/photo_xmp-2.jpg",
      "a/photo_xmp-4.jpg",
    ]);
    expect(new Set(resolved.map((path) => path.toLowerCase())).size).toBe(
      resolved.length,
    );
  });
});

describe("processing CSV", () => {
  test("creates a BOM-prefixed RFC4180 report with stable Chinese columns", () => {
    const csv = createCsv([
      result({
        relativePath: "商品图/粉色,梳妆台.jpg",
        outputName: "粉色梳妆台_xmp.jpg",
        message: '完成，含"引号"\n下一行',
      }),
    ]);

    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain(
      "相对路径,文件名,状态,处理结果,输出格式,是否重新编码,目标标签数量,耗时（毫秒）\r\n",
    );
    expect(csv).toContain('"商品图/粉色,梳妆台.jpg"');
    expect(csv).toContain('"完成，含""引号""\n下一行"');
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv).not.toContain("[object Blob]");
  });

  test("includes every state and protects formulas after whitespace", () => {
    const csv = createCsv([
      result({
        relativePath: " =HYPERLINK(\"https://bad\")/file.jpg",
        outputName: "+SUM_xmp.jpg",
      }),
      result({
        id: "@danger",
        state: "checked",
        output: null,
        outputFormat: null,
        outputName: null,
      }),
      result({
        state: "failed",
        output: null,
        outputFormat: null,
        outputName: null,
      }),
      result({
        state: "cancelled",
        output: null,
        outputFormat: null,
        outputName: null,
      }),
    ]);

    expect(csv).toContain("' =HYPERLINK");
    expect(csv).toContain("'+SUM_xmp.jpg");
    expect(csv).toContain("'@danger");
    expect(csv).toContain(",成功,");
    expect(csv).toContain(",已检查,");
    expect(csv).toContain(",失败,");
    expect(csv).toContain(",已取消,");
  });

  test("sanitizes local absolute paths and emits a valid empty report", () => {
    const csv = createCsv([
      result({
        relativePath: String.raw`C:\Users\Alice\Desktop\photo.jpg`,
        outputName: String.raw`..\photo_xmp.jpg`,
      }),
    ]);
    expect(csv).not.toContain("C:");
    expect(csv).not.toContain("\\");
    expect(csv).not.toContain("../");

    const empty = createCsv([]);
    expect(empty.startsWith("\uFEFF相对路径,")).toBe(true);
    expect(empty.split("\r\n")).toHaveLength(2);
  });

  test("replaces messages that contain absolute local paths", () => {
    const csv = createCsv([
      result({
        message:
          "macOS 文件位于 /Users/Alice/Desktop/private.jpg，请重试",
      }),
      result({
        message: "Linux 文件：/home/alice/private/image.png",
      }),
      result({
        message: String.raw`Windows 文件 C:\Users\Alice\secret.jpg 无法读取`,
      }),
      result({
        message: String.raw`UNC 文件 \\server\share\secret.jpg 无法读取`,
      }),
      result({
        message: String.raw`设备路径 \\?\C:\private\secret.jpg`,
      }),
      result({
        message: "根目录文件 /secret.jpg 无法读取",
      }),
      result({
        message: String.raw`当前盘文件 \Users\Alice\secret.jpg 无法读取`,
      }),
      result({
        message: "转发 UNC 文件 //server/share/secret.jpg 失败",
      }),
      result({
        message: "错误:/workspace/team/photo.jpg",
      }),
      result({
        message: "路径=/workspace/team/private.jpg",
      }),
      result({
        message:
          "帮助：https://example.com/help，错误:/workspace/private/secret.jpg",
      }),
    ]);

    for (const leaked of [
      "/Users/",
      "/home/",
      "/secret.jpg",
      "Alice",
      "C:",
      "\\",
      "server",
      "share",
      "private",
      "secret.jpg",
    ]) {
      expect(csv).not.toContain(leaked);
    }
    expect(csv).toContain("本地文件路径");
  });

  test("preserves ordinary prose and http URLs in safe messages", () => {
    const message =
      "支持 JPEG/PNG/WebP；帮助：https://example.com/home/docs 和 https://example.com/Users/docs 以及 http://example.org/private/docs";
    const csv = createCsv([result({ message })]);
    expect(csv).toContain(message);
    expect(csv).not.toContain("本地文件路径");
  });

  test("aligns standalone CSV output names to actual output format", () => {
    const csv = createCsv([
      result({
        relativePath: "folder/source.jpeg",
        outputName:
          "photo_xmp.this-is-a-very-long-fake-extension",
        outputFormat: "png",
        output: new Blob([
          new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          ]),
        ], { type: "image/png" }),
      }),
    ]);
    expect(csv).toContain(
      "folder/source.jpeg,photo_xmp.png,成功",
    );
    expect(csv).not.toContain("photo_xmp.jpg");
    expect(csv).not.toContain("fake-extension");
  });

  test("derives a real Task 8 success filename when outputName is null", () => {
    const csv = createCsv([
      result({
        relativePath: "folder/source.png",
        outputName: null,
        outputFormat: "jpeg",
      }),
    ]);
    expect(csv).toContain(
      "folder/source.png,source_xmp.jpg,成功",
    );
  });
});

describe("output ZIP", () => {
  test("creates a dated, store-only safe archive with images and report", async () => {
    const firstBytes = new Uint8Array([1, 2, 3, 4]);
    const secondBytes = new Uint8Array([5, 6, 7]);
    const sourceResults = [
      result({
        id: "one",
        relativePath: "../商品图/source.png",
        output: new Blob([firstBytes], { type: "image/jpeg" }),
        outputName: "source_xmp.jpg",
      }),
      result({
        id: "two",
        relativePath: "商品图/SOURCE.png",
        output: new Blob([secondBytes], { type: "image/jpeg" }),
        outputName: "SOURCE_xmp.jpg",
      }),
      result({
        id: "checked",
        state: "checked",
        relativePath: "not-included.jpg",
        output: new Blob([new Uint8Array([9])]),
        outputName: "not-included_xmp.jpg",
      }),
    ];
    const originalCopies = sourceResults.map((item) => ({
      relativePath: item.relativePath,
      outputName: item.outputName,
    }));
    const created = await createOutputZip(
      sourceResults,
      new Date(2026, 6, 26, 9, 5),
    );

    expect(created.filename).toBe("AI_XMP_Output_20260726-0905.zip");
    expect(created.blob.type).toBe("application/zip");
    const entries = await unzipStored(created.blob);
    expect(entries.map((entry) => entry.name)).toEqual([
      "AI_XMP_Output/商品图/source_xmp.jpg",
      "AI_XMP_Output/商品图/SOURCE_xmp-2.jpg",
      "AI_XMP_Output/processing-report.csv",
    ]);
    expect(entries.every((entry) => entry.method === 0)).toBe(true);
    expect(entries[0]?.bytes).toEqual(firstBytes);
    expect(entries[1]?.bytes).toEqual(secondBytes);
    const report = new TextDecoder().decode(entries[2]?.bytes);
    expect(report).toContain("商品图/source_xmp.jpg");
    expect(report).toContain("商品图/SOURCE_xmp-2.jpg");
    expect(report).toContain("not-included.jpg");
    expect(sourceResults.map((item) => ({
      relativePath: item.relativePath,
      outputName: item.outputName,
    }))).toEqual(originalCopies);
  });

  test("contains no Zip Slip, absolute, device, bidi, or duplicate entries", async () => {
    const created = await createOutputZip(
      [
        result({
          id: "one",
          relativePath: String.raw`\\?\C:\..\safe\photo.jpg`,
          outputName: String.raw`..\CON_xmp.jpg`,
        }),
        result({
          id: "two",
          relativePath: String.raw`\\server\share\safe\photo.jpg`,
          outputName: "con_xmp.jpg",
        }),
        result({
          id: "three",
          relativePath: "safe/\u202Eevil.jpg",
          outputName: "/absolute_xmp.jpg",
        }),
      ],
      new Date(2026, 0, 2, 3, 4),
    );
    const names = (await unzipStored(created.blob)).map(
      (entry) => entry.name,
    );
    const folded = names.map((name) => name.toLowerCase());

    expect(new Set(folded).size).toBe(names.length);
    for (const name of names) {
      expect(name.startsWith("AI_XMP_Output/")).toBe(true);
      expect(name).not.toMatch(/\\|(?:^|\/)\.\.(?:\/|$)/);
      expect(name).not.toMatch(/^[a-z]:/i);
      expect(name).not.toContain("\u202E");
      expect(new TextEncoder().encode(name).byteLength).toBeLessThanOrEqual(
        540,
      );
    }
  });

  test("falls back safely when Task 11 correlation metadata is absent", async () => {
    const created = await createOutputZip(
      [
        result({
          id: String.raw`C:\private\source.png`,
          outputName: null,
          outputFormat: "png",
        }),
      ],
      new Date(2026, 0, 2, 3, 4),
    );
    const entries = await unzipStored(created.blob);
    expect(entries[0]?.name).toBe(
      "AI_XMP_Output/source_xmp.png",
    );
    expect(entries[0]?.name).not.toContain("private");
  });

  test("aligns ZIP and report names with the actual output format", async () => {
    const pngMagic = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const created = await createOutputZip(
      [
        result({
          relativePath: "folder/source.jpg",
          outputName: "source_xmp.jpg",
          outputFormat: "png",
          output: new Blob([pngMagic], { type: "image/png" }),
        }),
      ],
      new Date(2026, 0, 2, 3, 4),
    );
    const entries = await unzipStored(created.blob);
    expect(entries[0]?.name).toBe(
      "AI_XMP_Output/folder/source_xmp.png",
    );
    expect(entries[0]?.bytes).toEqual(pngMagic);
    expect(new TextDecoder().decode(entries[1]?.bytes)).toContain(
      "folder/source_xmp.png,source_xmp.png",
    );
  });

  test("snapshots mutable inputs before yielding to Blob streams", async () => {
    let release = (): void => {
      throw new Error("Gate was not initialized");
    };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const delayed = new Blob([bytes], { type: "image/png" });
    Object.defineProperty(delayed, "stream", {
      configurable: true,
      value: () =>
        new ReadableStream<Uint8Array>({
          async start(controller) {
            await gate;
            controller.enqueue(bytes);
            controller.close();
          },
        }),
    });
    const mutable = result({
      id: "snapshot",
      relativePath: "before/source.png",
      outputName: "source_xmp.png",
      outputFormat: "png",
      output: delayed,
      message: "调用时消息",
    });
    const date = new Date(2026, 0, 2, 3, 4);

    const pending = createOutputZip([mutable], date);
    mutable.relativePath = "after/private.jpg";
    mutable.outputName = "changed_xmp.jpg";
    mutable.outputFormat = "jpeg";
    mutable.output = new Blob([
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    ], { type: "image/jpeg" });
    mutable.message = "修改后消息";
    date.setFullYear(2040);
    release();

    const created = await pending;
    const entries = await unzipStored(created.blob);
    expect(created.filename).toBe("AI_XMP_Output_20260102-0304.zip");
    expect(entries[0]?.name).toBe(
      "AI_XMP_Output/before/source_xmp.png",
    );
    expect(entries[0]?.bytes).toEqual(bytes);
    expect(new TextDecoder().decode(entries[1]?.bytes)).toContain(
      "调用时消息",
    );
    expect(new TextDecoder().decode(entries[1]?.bytes)).not.toContain(
      "修改后消息",
    );
  });

  test("writes valid CRCs and clamps dates to the DOS ZIP range", async () => {
    const created = await createOutputZip(
      [result()],
      new Date(1970, 0, 1, 12, 34),
    );
    const entries = await unzipStored(created.blob);
    expect(created.filename).toBe("AI_XMP_Output_19800101-0000.zip");
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.crc32).toBe(crc32(entry.bytes));
      expect(((entry.dosDate >>> 9) & 0x7f) + 1980).toBe(1980);
      expect(entry.dosTime).toBe(0);
    }
  });

  test("creates a report-only archive when there are no successes", async () => {
    const created = await createOutputZip(
      [
        result({
          state: "failed",
          output: null,
          outputName: null,
          outputFormat: null,
        }),
      ],
      new Date(2026, 10, 9, 8, 7),
    );
    const entries = await unzipStored(created.blob);
    expect(created.filename).toBe("AI_XMP_Output_20261109-0807.zip");
    expect(entries.map((entry) => entry.name)).toEqual([
      "AI_XMP_Output/processing-report.csv",
    ]);
  });

  test("excludes invalid non-Blob success outputs at the ZIP boundary", async () => {
    const invalid = result({
      outputName: "invalid_xmp.jpg",
    }) as unknown as ReportableResult;
    Object.assign(invalid, {
      output: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    });

    const created = await createOutputZip(
      [invalid],
      new Date(2026, 0, 2, 3, 4),
    );
    const entries = await unzipStored(created.blob);
    expect(entries.map((entry) => entry.name)).toEqual([
      "AI_XMP_Output/processing-report.csv",
    ]);
  });
});
