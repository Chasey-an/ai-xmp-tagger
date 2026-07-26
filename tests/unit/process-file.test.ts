// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { TARGET_SUBJECT } from "../../src/core/constants";
import {
  processFile,
  type ProcessFileDependencies,
  type ProcessRequest,
} from "../../src/core/process-file";
import type {
  ImageFormat,
  ProcessingMode,
} from "../../src/core/types";
import {
  extractJpegScan,
  readJpegXmp,
  writeJpegXmp,
} from "../../src/core/xmp/jpeg";
import { readPngXmp, writePngXmp } from "../../src/core/xmp/png";
import { inspectPacket } from "../../src/core/xmp/model";
import { readWebpXmp, writeWebpXmp } from "../../src/core/xmp/webp";
import {
  concatBytes,
  knownValidJpeg1x1,
  knownValidPng1x1,
  knownValidWebp1x1,
  minimalPng,
  minimalWebp,
  pngChunk,
  utf8Bytes,
  webpChunk,
} from "../helpers/binary-fixtures";

const OTHER_SUBJECT = "existing-keyword";

function packet(options: {
  subjects?: readonly string[];
  extraProperty?: string;
} = {}): string {
  const subjects = options.subjects ?? [];
  return [
    '<?xpacket begin="\uFEFF"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about=""',
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"',
    ' xmlns:exif="http://ns.adobe.com/exif/1.0/"',
    ' xmlns:test="urn:process-file-test">',
    "<dc:subject><rdf:Bag>",
    ...subjects.map(
      (subject) =>
        `<rdf:li>${subject
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")}</rdf:li>`,
    ),
    "</rdf:Bag></dc:subject>",
    options.extraProperty ?? "",
    "</rdf:Description></rdf:RDF></x:xmpmeta>",
    '<?xpacket end="w"?>',
  ].join("");
}

function fileFrom(
  bytes: Uint8Array,
  format: ImageFormat,
  name = `fixture.${format === "jpeg" ? "jpg" : format}`,
): File {
  return new File([Uint8Array.from(bytes)], name, {
    type: format === "jpeg" ? "image/jpeg" : `image/${format}`,
  });
}

function baseBytes(format: ImageFormat): Uint8Array {
  switch (format) {
    case "jpeg":
      return knownValidJpeg1x1();
    case "png":
      return knownValidPng1x1();
    case "webp":
      return knownValidWebp1x1();
    case "bmp":
      return new Uint8Array([0x42, 0x4d, 0, 0]);
  }
}

function request(
  format: ImageFormat,
  mode: ProcessingMode,
  bytes = baseBytes(format),
): ProcessRequest {
  return {
    id: `${format}-${mode}`,
    file: fileFrom(bytes, format),
    format,
    relativePath: `folder/${format}`,
    mode,
  };
}

const conversionDependencies: ProcessFileDependencies = {
  decodeRaster: vi.fn(async () => ({
    width: 1,
    height: 1,
    data: new Uint8ClampedArray([255, 255, 255, 255]),
  })),
  encodeHighQualityJpeg: vi.fn(async () => knownValidJpeg1x1()),
};

function readOutputPacket(format: ImageFormat, output: Blob): Promise<string | null> {
  return output.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    switch (format) {
      case "jpeg":
        return readJpegXmp(bytes);
      case "png":
        return readPngXmp(bytes);
      case "webp":
        return readWebpXmp(bytes);
      case "bmp":
        throw new Error("BMP cannot contain output XMP");
    }
  });
}

describe("processFile mode matrix", () => {
  it.each([
    ["jpeg", "jpeg", false],
    ["png", "jpeg", true],
    ["webp", "jpeg", true],
    ["bmp", "jpeg", true],
  ] as const)(
    "jpeg-and-xmp: %s succeeds as %s (reencoded=%s)",
    async (format, outputFormat, reencoded) => {
      const result = await processFile(
        request(format, "jpeg-and-xmp"),
        conversionDependencies,
      );

      expect(result).toMatchObject({
        id: `${format}-jpeg-and-xmp`,
        state: "success",
        outputFormat,
        outputName: null,
        subjectExists: true,
        targetTagCount: 1,
        reencoded,
      });
      expect(result.output).toBeInstanceOf(Blob);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(result.elapsedMs)).toBe(true);
      expect(
        inspectPacket(await readOutputPacket(outputFormat, result.output!)),
      ).toMatchObject({ targetTagCount: 1 });
    },
  );

  it.each([
    ["jpeg", "jpeg"],
    ["png", "png"],
    ["webp", "webp"],
  ] as const)(
    "original-and-xmp: %s succeeds without re-encoding",
    async (format, outputFormat) => {
      const input = baseBytes(format);
      const result = await processFile(
        request(format, "original-and-xmp", input),
        conversionDependencies,
      );

      expect(result).toMatchObject({
        state: "success",
        outputFormat,
        outputName: null,
        targetTagCount: 1,
        reencoded: false,
      });
      expect(result.output).toBeInstanceOf(Blob);
      expect(
        inspectPacket(await readOutputPacket(outputFormat, result.output!)),
      ).toMatchObject({ targetTagCount: 1 });
      if (format === "jpeg") {
        expect(
          extractJpegScan(new Uint8Array(await result.output!.arrayBuffer())),
        ).toEqual(extractJpegScan(input));
      }
    },
  );

  it("original-and-xmp rejects BMP with a clear mode message", async () => {
    const result = await processFile(
      request("bmp", "original-and-xmp"),
      conversionDependencies,
    );

    expect(result).toMatchObject({
      state: "failed",
      output: null,
      outputFormat: null,
      outputName: null,
      reencoded: false,
    });
    expect(result.message).toMatch(/BMP.*原格式|原格式.*BMP/);
  });

  it.each(["jpeg", "png", "webp"] as const)(
    "verify-only checks %s without output or mutation",
    async (format) => {
      const sourcePacket = packet({
        subjects: [OTHER_SUBJECT, TARGET_SUBJECT, TARGET_SUBJECT],
      });
      const source = writePacket(format, baseBytes(format), sourcePacket);
      const before = source.slice();

      const result = await processFile(
        request(format, "verify-only", source),
        conversionDependencies,
      );

      expect(result).toMatchObject({
        state: "checked",
        output: null,
        outputFormat: null,
        outputName: null,
        subjectExists: true,
        targetTagCount: 2,
        reencoded: false,
      });
      expect(source).toEqual(before);
    },
  );

  it("verify-only rejects BMP with a clear mode message", async () => {
    const result = await processFile(
      request("bmp", "verify-only"),
      conversionDependencies,
    );

    expect(result).toMatchObject({
      state: "failed",
      output: null,
      outputFormat: null,
      targetTagCount: 0,
      reencoded: false,
    });
    expect(result.message).toMatch(/BMP.*检查|检查.*BMP/);
  });
});

describe("processFile XMP and safety invariants", () => {
  it("normalizes duplicate targets to one while preserving other subjects", async () => {
    const input = writeJpegXmp(
      knownValidJpeg1x1(),
      packet({
        subjects: [TARGET_SUBJECT, OTHER_SUBJECT, TARGET_SUBJECT],
      }),
    );

    const result = await processFile(
      request("jpeg", "original-and-xmp", input),
      conversionDependencies,
    );

    expect(result.state).toBe("success");
    const check = inspectPacket(
      readJpegXmp(new Uint8Array(await result.output!.arrayBuffer())),
    );
    expect(check).toEqual({
      subjectExists: true,
      subjects: [OTHER_SUBJECT, TARGET_SUBJECT],
      targetTagCount: 1,
    });
  });

  it("conversion retains only dc:subject and drops EXIF/GPS/other XMP properties", async () => {
    const sourcePacket = packet({
      subjects: [OTHER_SUBJECT],
      extraProperty:
        "<exif:GPSLatitude>31,14.5N</exif:GPSLatitude>" +
        "<test:SecretMetadata>drop-me</test:SecretMetadata>",
    });
    const nativeExifMarker = utf8Bytes("native-exif-must-be-dropped");
    const input = writePngXmp(
      minimalPng([pngChunk("eXIf", nativeExifMarker)]),
      sourcePacket,
    );

    const result = await processFile(
      request("png", "jpeg-and-xmp", input),
      conversionDependencies,
    );

    expect(result.state).toBe("success");
    const outputPacket = readJpegXmp(
      new Uint8Array(await result.output!.arrayBuffer()),
    );
    expect(inspectPacket(outputPacket)).toEqual({
      subjectExists: true,
      subjects: [OTHER_SUBJECT, TARGET_SUBJECT],
      targetTagCount: 1,
    });
    expect(outputPacket).not.toContain("GPSLatitude");
    expect(outputPacket).not.toContain("SecretMetadata");
    expect(outputPacket).not.toContain("drop-me");
    const outputBytes = new Uint8Array(await result.output!.arrayBuffer());
    expect(
      new TextDecoder("latin1").decode(outputBytes),
    ).not.toContain("native-exif-must-be-dropped");
  });

  it("refuses animated WebP before invoking the decoder", async () => {
    const decodeRaster = vi.fn(async () => ({
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([255, 255, 255, 255]),
    }));
    const animated = animatedWebp();

    const result = await processFile(request("webp", "jpeg-and-xmp", animated), {
      ...conversionDependencies,
      decodeRaster,
    });

    expect(result.state).toBe("failed");
    expect(result.message).toMatch(/动态 WebP/);
    expect(decodeRaster).not.toHaveBeenCalled();
  });

  it("returns a safe actionable failure for corrupt container bytes", async () => {
    const result = await processFile(
      request("jpeg", "original-and-xmp", new Uint8Array([1, 2, 3])),
      conversionDependencies,
    );

    expect(result).toMatchObject({
      state: "failed",
      output: null,
      outputFormat: null,
      outputName: null,
    });
    expect(result.message).toMatch(/损坏|完整|格式/);
    expect(result.message).not.toContain("/");
  });

  it("returns a safe failure for malformed existing XMP", async () => {
    const input = writePngXmp(knownValidPng1x1(), "<x:xmpmeta>");

    const result = await processFile(
      request("png", "original-and-xmp", input),
      conversionDependencies,
    );

    expect(result.state).toBe("failed");
    expect(result.message).toMatch(/XMP/);
    expect(result.message).not.toContain("process-file.ts");
  });

  it("rejects an unsupported runtime format without throwing", async () => {
    const unsupported = {
      ...request("png", "verify-only"),
      format: "gif",
    } as unknown as ProcessRequest;

    const result = await processFile(unsupported, conversionDependencies);

    expect(result.state).toBe("failed");
    expect(result.message).toMatch(/不支持.*格式|格式.*不支持/);
  });

  it("fails closed when actual container re-read finds verification mismatch", async () => {
    const result = await processFile(
      request("jpeg", "original-and-xmp"),
      {
        ...conversionDependencies,
        beforeVerifyOutput(bytes, format) {
          expect(format).toBe("jpeg");
          return writeJpegXmp(
            bytes,
            packet({ subjects: [OTHER_SUBJECT] }),
          );
        },
      },
    );

    expect(result).toMatchObject({
      state: "failed",
      output: null,
      outputFormat: null,
      outputName: null,
      subjectExists: true,
      targetTagCount: 0,
      reencoded: false,
    });
    expect(result.message).toMatch(/验证|写入/);
  });

  it("maps cancellation distinctly and never leaks thrown details", async () => {
    const result = await processFile(request("png", "jpeg-and-xmp"), {
      ...conversionDependencies,
      decodeRaster: async () => {
        const error = new Error("/Users/private/source.png");
        error.name = "AbortError";
        throw error;
      },
    });

    expect(result).toMatchObject({
      state: "cancelled",
      output: null,
      outputFormat: null,
      outputName: null,
    });
    expect(result.message).toMatch(/取消/);
    expect(result.message).not.toContain("/Users");
  });
});

function writePacket(
  format: Exclude<ImageFormat, "bmp">,
  bytes: Uint8Array,
  value: string,
): Uint8Array {
  switch (format) {
    case "jpeg":
      return writeJpegXmp(bytes, value);
    case "png":
      return writePngXmp(bytes, value);
    case "webp":
      return writeWebpXmp(bytes, value);
  }
}

function vp8Data(width = 1, height = 1): Uint8Array {
  return new Uint8Array([
    0x10, 0, 0, 0x9d, 0x01, 0x2a,
    width & 0xff, (width >>> 8) & 0x3f,
    height & 0xff, (height >>> 8) & 0x3f,
  ]);
}

function vp8xData(flags: number, width = 1, height = 1): Uint8Array {
  return new Uint8Array([
    flags, 0, 0, 0,
    (width - 1) & 0xff, 0, 0,
    (height - 1) & 0xff, 0, 0,
  ]);
}

function animatedWebp(): Uint8Array {
  const frameHeader = new Uint8Array(16);
  const frame = concatBytes(frameHeader, webpChunk("VP8 ", vp8Data()));
  return minimalWebp([
    webpChunk("VP8X", vp8xData(0x02)),
    webpChunk("ANIM", new Uint8Array(6)),
    webpChunk("ANMF", frame),
  ]);
}
