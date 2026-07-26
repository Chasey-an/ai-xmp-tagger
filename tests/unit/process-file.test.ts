// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { getSrgb2014Profile } from "../../src/assets/srgb2014";
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
  jpegSegment,
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
  encodeHighQualityJpeg: vi.fn(async () => trustedEncodedJpeg()),
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
    expect(result.message).toContain("转为高清 JPEG 并写入标签");
  });
});

describe("processFile XMP and safety invariants", () => {
  it.each([
    {
      label: "exactly one target",
      xmp: packet({ subjects: [TARGET_SUBJECT] }),
      expected: {
        subjectExists: true,
        targetTagCount: 1,
        message: /检查通过.*1 个/,
      },
    },
    {
      label: "no dc:subject field",
      xmp: null,
      expected: {
        subjectExists: false,
        targetTagCount: 0,
        message: /未找到.*dc:subject.*写入模式/,
      },
    },
    {
      label: "dc:subject without the target",
      xmp: packet({ subjects: [OTHER_SUBJECT] }),
      expected: {
        subjectExists: true,
        targetTagCount: 0,
        message: /已找到.*dc:subject.*未找到.*目标标签.*写入模式/,
      },
    },
    {
      label: "duplicate targets",
      xmp: packet({
        subjects: [TARGET_SUBJECT, TARGET_SUBJECT],
      }),
      expected: {
        subjectExists: true,
        targetTagCount: 2,
        message: /检查未通过.*重复.*2 次.*归一化/,
      },
    },
  ])(
    "verify-only reports $label as a distinct Chinese result",
    async ({ xmp, expected }) => {
      const input =
        xmp === null
          ? knownValidJpeg1x1()
          : writeJpegXmp(knownValidJpeg1x1(), xmp);

      const result = await processFile(
        request("jpeg", "verify-only", input),
        conversionDependencies,
      );

      expect(result).toMatchObject({
        state: "checked",
        output: null,
        outputFormat: null,
        subjectExists: expected.subjectExists,
        targetTagCount: expected.targetTagCount,
      });
      expect(result.message).toMatch(expected.message);
    },
  );

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

  it("sanitizes all unapproved encoder JPEG metadata before generated XMP is written", async () => {
    const result = await processFile(
      request("png", "jpeg-and-xmp"),
      {
        ...conversionDependencies,
        encodeHighQualityJpeg: async () => maliciousEncodedJpeg(),
      },
    );

    expect(result.state).toBe("success");
    const output = new Uint8Array(await result.output!.arrayBuffer());
    const text = new TextDecoder("latin1").decode(output);
    expect(text).toContain("JFIF");
    expect(text).not.toContain("encoder-secret-exif");
    expect(text).not.toContain("encoder-secret-iptc");
    expect(text).not.toContain("encoder-secret-comment");
    expect(text).not.toContain("encoder-secret-private-app");
    expect(text).not.toContain("encoder-old-subject");
    expect(readIccProfile(output)).toEqual(getSrgb2014Profile());
    expect(jpegHeaderMarkers(output)).toEqual(
      expect.arrayContaining([0xdb, 0xc4, 0xc0, 0xda]),
    );
    expect(inspectPacket(readJpegXmp(output))).toEqual({
      subjectExists: true,
      subjects: [TARGET_SUBJECT],
      targetTagCount: 1,
    });
  });

  it("reads a BMP File only once during default conversion", async () => {
    const bytes = validBmp1x1();
    const arrayBuffer = vi.fn(async () => Uint8Array.from(bytes).buffer);
    const file = {
      name: "single-read.bmp",
      type: "image/bmp",
      size: bytes.length,
      arrayBuffer,
      slice: (start = 0, end = bytes.length) =>
        new Blob([bytes.slice(start, end)]),
    } as unknown as File;

    const result = await processFile(
      {
        id: "single-read",
        file,
        format: "bmp",
        relativePath: "single-read.bmp",
        mode: "jpeg-and-xmp",
      },
      {
        encodeHighQualityJpeg: async () => trustedEncodedJpeg(),
      },
    );

    expect(result.state).toBe("success");
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
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
    expect(result.message).toContain("保持原格式并写入 XMP");
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

  it("gives an actionable, non-overwriting next step for XMP conflicts", async () => {
    const conflictPacket = packet({ subjects: [OTHER_SUBJECT] }).replace(
      "</rdf:Description>",
      "<dc:subject><rdf:Bag><rdf:li>second</rdf:li></rdf:Bag></dc:subject>" +
        "</rdf:Description>",
    );
    const input = writePngXmp(knownValidPng1x1(), conflictPacket);

    const result = await processFile(
      request("png", "original-and-xmp", input),
      conversionDependencies,
    );

    expect(result.state).toBe("failed");
    expect(result.message).toMatch(/冲突.*清理|冲突.*重新导出/);
    expect(result.message).toMatch(/不会自动覆盖|不会静默覆盖/);
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

  it("uses injected bytes only for verification and never as returned output", async () => {
    const replacementSubject = "verification-only-replacement";
    const source = knownValidJpeg1x1();
    const result = await processFile(
      request("jpeg", "original-and-xmp", source),
      {
        beforeVerifyOutput(bytes) {
          bytes[bytes.length - 3] =
            bytes[bytes.length - 3]! ^ 0xff;
          return writeJpegXmp(
            bytes,
            packet({
              subjects: [replacementSubject, TARGET_SUBJECT],
            }),
          );
        },
      },
    );

    expect(result.state).toBe("success");
    const returnedPacket = readJpegXmp(
      new Uint8Array(await result.output!.arrayBuffer()),
    );
    expect(inspectPacket(returnedPacket)).toEqual({
      subjectExists: true,
      subjects: [TARGET_SUBJECT],
      targetTagCount: 1,
    });
    expect(returnedPacket).not.toContain(replacementSubject);
    const returnedBytes = new Uint8Array(
      await result.output!.arrayBuffer(),
    );
    expect(returnedBytes[returnedBytes.length - 3]).toBe(
      source[source.length - 3],
    );
  });

  it("reports an accurate actionable failure for an unknown runtime mode", async () => {
    const invalid = {
      ...request("jpeg", "verify-only"),
      mode: "mystery-mode",
    } as unknown as ProcessRequest;

    const result = await processFile(invalid, conversionDependencies);

    expect(result.state).toBe("failed");
    expect(result.message).toMatch(/处理模式.*无效|不支持.*处理模式/);
    expect(result.message).toMatch(/重新选择|选择.*模式/);
    expect(result.message).not.toMatch(/图片格式/);
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

function trustedEncodedJpeg(): Uint8Array {
  const profile = getSrgb2014Profile();
  const app0 = jpegSegment(
    0xe0,
    concatBytes(
      utf8Bytes("JFIF\0"),
      [1, 1, 0, 0, 1, 0, 1, 0, 0],
    ),
  );
  const icc = jpegSegment(
    0xe2,
    concatBytes(utf8Bytes("ICC_PROFILE\0"), [1, 1], profile),
  );
  const dqt = jpegSegment(0xdb, [0, ...new Uint8Array(64).fill(1)]);
  const sof0 = jpegSegment(0xc0, [
    8,
    0, 1,
    0, 1,
    3,
    1, 0x11, 0,
    2, 0x11, 1,
    3, 0x11, 1,
  ]);
  const dht = jpegSegment(0xc4, [
    0,
    1, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0,
    0,
  ]);
  const sos = jpegSegment(0xda, [
    3,
    1, 0,
    2, 0x11,
    3, 0x11,
    0, 0x3f, 0,
  ]);
  return concatBytes(
    [0xff, 0xd8],
    app0,
    icc,
    dqt,
    sof0,
    dht,
    sos,
    [0, 0xff, 0xd9],
  );
}

function maliciousEncodedJpeg(): Uint8Array {
  const jpeg = trustedEncodedJpeg();
  const app0Length = jpeg[4]! * 0x100 + jpeg[5]!;
  const app0End = 4 + app0Length;
  const oldXmp = packet({ subjects: ["encoder-old-subject"] });
  return concatBytes(
    jpeg.subarray(0, app0End),
    jpegSegment(
      0xe1,
      concatBytes(
        utf8Bytes("Exif\0\0"),
        utf8Bytes("encoder-secret-exif"),
      ),
    ),
    jpegSegment(0xed, utf8Bytes("encoder-secret-iptc")),
    jpegSegment(0xfe, utf8Bytes("encoder-secret-comment")),
    jpegSegment(0xec, utf8Bytes("encoder-secret-private-app")),
    jpegSegment(
      0xe1,
      concatBytes(
        utf8Bytes("http://ns.adobe.com/xap/1.0/\0"),
        utf8Bytes(oldXmp),
      ),
    ),
    jpeg.subarray(app0End),
  );
}

function readIccProfile(jpeg: Uint8Array): Uint8Array {
  const chunks = new Map<number, Uint8Array>();
  let total = 0;
  let offset = 2;
  while (offset < jpeg.length) {
    if (jpeg[offset] !== 0xff) {
      throw new Error("Invalid JPEG marker");
    }
    const marker = jpeg[offset + 1]!;
    const length = jpeg[offset + 2]! * 0x100 + jpeg[offset + 3]!;
    const end = offset + 2 + length;
    if (marker === 0xda) break;
    if (marker === 0xe2) {
      const payload = jpeg.subarray(offset + 4, end);
      const signature = utf8Bytes("ICC_PROFILE\0");
      if (
        signature.every((value, index) => payload[index] === value)
      ) {
        const sequence = payload[signature.length]!;
        total = payload[signature.length + 1]!;
        chunks.set(sequence, payload.slice(signature.length + 2));
      }
    }
    offset = end;
  }
  return concatBytes(
    ...Array.from({ length: total }, (_, index) => {
      const chunk = chunks.get(index + 1);
      if (chunk === undefined) {
        throw new Error("Missing ICC chunk");
      }
      return chunk;
    }),
  );
}

function jpegHeaderMarkers(jpeg: Uint8Array): number[] {
  const markers: number[] = [];
  let offset = 2;
  while (offset < jpeg.length) {
    if (jpeg[offset] !== 0xff) {
      throw new Error("Invalid JPEG marker");
    }
    const marker = jpeg[offset + 1]!;
    markers.push(marker);
    const length = jpeg[offset + 2]! * 0x100 + jpeg[offset + 3]!;
    offset += 2 + length;
    if (marker === 0xda) {
      return markers;
    }
  }
  throw new Error("Missing JPEG SOS");
}

function validBmp1x1(): Uint8Array {
  const bytes = new Uint8Array(58);
  const view = new DataView(bytes.buffer);
  bytes.set([0x42, 0x4d]);
  view.setUint32(2, bytes.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, 1, true);
  view.setInt32(22, 1, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, 4, true);
  bytes.set([30, 20, 10, 0], 54);
  return bytes;
}
