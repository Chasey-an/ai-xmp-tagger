import { expect, test } from "@playwright/test";

const ICC_SHA256 =
  "384b832de3412066743b52a75ee906b6fb9fb8d9e09e936fc2c43223815c6e0a";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => window.conversionHarness !== undefined);
});

test("native PNG and WebP decode are dimension-safe and white-flatten alpha", async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { decodeRaster } = window.conversionHarness;

    async function makeFile(type) {
      const canvas = document.createElement("canvas");
      canvas.width = 2;
      canvas.height = 1;
      const context = canvas.getContext("2d");
      context.putImageData(new ImageData(new Uint8ClampedArray([
        10, 20, 30, 128,
        0, 0, 0, 0,
      ]), 2, 1), 0, 0);
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (value) => value === null ? reject(new Error(`${type} unsupported`)) : resolve(value),
          type,
          1,
        );
      });
      return new File([blob], type === "image/png" ? "neutral.png" : "neutral.webp", { type });
    }

    const png = await decodeRaster(await makeFile("image/png"), "png");
    const webp = await decodeRaster(await makeFile("image/webp"), "webp");
    return {
      png: { width: png.width, height: png.height, data: [...png.data] },
      webp: { width: webp.width, height: webp.height, data: [...webp.data] },
    };
  });

  expect(results.png).toEqual({
    width: 2,
    height: 1,
    data: [132, 137, 142, 255, 255, 255, 255, 255],
  });
  expect(results.webp.width).toBe(2);
  expect(results.webp.height).toBe(1);
  expect(results.webp.data[3]).toBe(255);
  expect(results.webp.data.slice(4)).toEqual([255, 255, 255, 255]);
});

test("animated WebP is rejected before native decode", async ({ page }) => {
  const error = await page.evaluate(async () => {
    const { decodeRaster } = window.conversionHarness;
    const concat = (...parts) => {
      const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
      let offset = 0;
      for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
      }
      return result;
    };
    const ascii = (text) => new TextEncoder().encode(text);
    const chunk = (fourcc, data) => concat(
      ascii(fourcc),
      new Uint8Array([
        data.length & 0xff,
        (data.length >>> 8) & 0xff,
        (data.length >>> 16) & 0xff,
        data.length >>> 24,
      ]),
      data,
      data.length % 2 === 1 ? new Uint8Array([0]) : new Uint8Array(),
    );
    const frameHeader = new Uint8Array(16);
    frameHeader[12] = 1;
    const vp8 = chunk("VP8 ", new Uint8Array([
      0x10, 0, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0,
    ]));
    const body = concat(
      ascii("WEBP"),
      chunk("VP8X", new Uint8Array([0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
      chunk("ANIM", new Uint8Array(6)),
      chunk("ANMF", concat(frameHeader, vp8)),
    );
    const bytes = concat(
      ascii("RIFF"),
      new Uint8Array([
        body.length & 0xff,
        (body.length >>> 8) & 0xff,
        (body.length >>> 16) & 0xff,
        body.length >>> 24,
      ]),
      body,
    );

    try {
      await decodeRaster(new File([bytes], "animated.webp", { type: "image/webp" }), "webp");
      return null;
    } catch (caught) {
      return { code: caught.code, message: caught.message };
    }
  });

  expect(error).toMatchObject({
    code: "DECODE_FAILED",
  });
  expect(error.message).toContain("动态 WebP");
});

test("oriented PNG and WebP normalize 90-degree rotation and physical pixels", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { decodeRaster } = window.conversionHarness;
    const concat = (...parts) => {
      const output = new Uint8Array(
        parts.reduce((total, part) => total + part.length, 0),
      );
      let offset = 0;
      for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
      }
      return output;
    };
    const ascii = (value) => new TextEncoder().encode(value);
    const tiff = new Uint8Array([
      0x49, 0x49, 0x2a, 0,
      8, 0, 0, 0,
      1, 0,
      0x12, 0x01,
      3, 0,
      1, 0, 0, 0,
      6, 0, 0, 0,
      0, 0, 0, 0,
    ]);
    const crc32 = (bytes) => {
      let crc = 0xffffffff;
      for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
          crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
      }
      return (crc ^ 0xffffffff) >>> 0;
    };
    const pngChunk = (type, data) => {
      const body = concat(ascii(type), data);
      const crc = crc32(body);
      return concat(
        new Uint8Array([
          data.length >>> 24,
          (data.length >>> 16) & 0xff,
          (data.length >>> 8) & 0xff,
          data.length & 0xff,
        ]),
        body,
        new Uint8Array([
          crc >>> 24,
          (crc >>> 16) & 0xff,
          (crc >>> 8) & 0xff,
          crc & 0xff,
        ]),
      );
    };
    const webpChunk = (fourcc, data) => concat(
      ascii(fourcc),
      new Uint8Array([
        data.length & 0xff,
        (data.length >>> 8) & 0xff,
        (data.length >>> 16) & 0xff,
        data.length >>> 24,
      ]),
      data,
      data.length & 1 ? new Uint8Array([0]) : new Uint8Array(),
    );

    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 1;
    canvas.getContext("2d").putImageData(new ImageData(
      new Uint8ClampedArray([
        0, 0, 0, 255,
        255, 255, 255, 255,
      ]),
      2,
      1,
    ), 0, 0);
    const toBlob = (type) => new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob === null
          ? reject(new Error(`${type} encoding unavailable`))
          : resolve(blob),
        type,
        1,
      );
    });

    const pngBytes = new Uint8Array(
      await (await toBlob("image/png")).arrayBuffer(),
    );
    const orientedPng = concat(
      pngBytes.subarray(0, 33),
      pngChunk("eXIf", tiff),
      pngBytes.subarray(33),
    );

    const webpBytes = new Uint8Array(
      await (await toBlob("image/webp")).arrayBuffer(),
    );
    const originalChunks = [];
    let originalAlphaFlag = false;
    let offset = 12;
    while (offset < webpBytes.length) {
      const length =
        webpBytes[offset + 4] +
        webpBytes[offset + 5] * 0x100 +
        webpBytes[offset + 6] * 0x10000 +
        webpBytes[offset + 7] * 0x1000000;
      const end = offset + 8 + length + (length & 1);
      const fourcc = new TextDecoder().decode(
        webpBytes.subarray(offset, offset + 4),
      );
      if (fourcc === "VP8X") {
        originalAlphaFlag = (webpBytes[offset + 8] & 0x10) !== 0;
      }
      if (fourcc !== "VP8X" && fourcc !== "EXIF") {
        const raw = webpBytes.slice(offset, end);
        if (fourcc === "ALPH") {
          originalAlphaFlag = true;
        } else if (fourcc === "VP8L" && raw.length >= 13) {
          const packed =
            raw[9] +
            raw[10] * 0x100 +
            raw[11] * 0x10000 +
            raw[12] * 0x1000000;
          originalAlphaFlag ||= (packed & 0x10000000) !== 0;
        }
        originalChunks.push({ fourcc, raw });
      }
      offset = end;
    }
    let vp8xFlags = 0x08;
    if (originalAlphaFlag) vp8xFlags |= 0x10;
    if (originalChunks.some(({ fourcc }) => fourcc === "ICCP")) {
      vp8xFlags |= 0x20;
    }
    if (originalChunks.some(({ fourcc }) => fourcc === "XMP ")) {
      vp8xFlags |= 0x04;
    }
    const vp8x = new Uint8Array([
      vp8xFlags, 0, 0, 0,
      1, 0, 0,
      0, 0, 0,
    ]);
    const extendedChunks = [];
    let exifInserted = false;
    for (const chunkValue of originalChunks) {
      if (
        !exifInserted &&
        ["ALPH", "VP8 ", "VP8L"].includes(chunkValue.fourcc)
      ) {
        extendedChunks.push(
          webpChunk(
            "EXIF",
            concat(ascii("Exif"), new Uint8Array([0, 0]), tiff),
          ),
        );
        exifInserted = true;
      }
      extendedChunks.push(chunkValue.raw);
    }
    if (!exifInserted) {
      throw new Error("Canvas WebP contained no static image chunk");
    }
    const webpBody = concat(
      ascii("WEBP"),
      webpChunk("VP8X", vp8x),
      ...extendedChunks,
    );
    const orientedWebp = concat(
      ascii("RIFF"),
      new Uint8Array([
        webpBody.length & 0xff,
        (webpBody.length >>> 8) & 0xff,
        (webpBody.length >>> 16) & 0xff,
        webpBody.length >>> 24,
      ]),
      webpBody,
    );

    const png = await decodeRaster(
      new File([orientedPng], "oriented.png", { type: "image/png" }),
      "png",
    );
    const webp = await decodeRaster(
      new File([orientedWebp], "oriented.webp", { type: "image/webp" }),
      "webp",
    );
    return {
      png: { width: png.width, height: png.height, data: [...png.data] },
      webp: { width: webp.width, height: webp.height, data: [...webp.data] },
    };
  });

  expect(result.png).toEqual({
    width: 1,
    height: 2,
    data: [
      0, 0, 0, 255,
      255, 255, 255, 255,
    ],
  });
  expect(result.webp).toMatchObject({ width: 1, height: 2 });
  expect(result.webp.data[3]).toBe(255);
  expect(result.webp.data[7]).toBe(255);
  expect(result.webp.data[0]).toBeLessThan(80);
  expect(result.webp.data[1]).toBeLessThan(80);
  expect(result.webp.data[2]).toBeLessThan(80);
  expect(result.webp.data[4]).toBeGreaterThan(175);
  expect(result.webp.data[5]).toBeGreaterThan(175);
  expect(result.webp.data[6]).toBeGreaterThan(175);
});

test("real WASM encode is baseline 4:4:4 with exact ICC and independently decodable", async ({ page }) => {
  const wasmResponses = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.endsWith(".wasm")) {
      wasmResponses.push({
        url: response.url(),
        status: response.status(),
        contentType: response.headers()["content-type"] ?? "",
      });
    }
  });
  const result = await page.evaluate(async () => {
    const { encodeHighQualityJpeg } = window.conversionHarness;
    const jpeg = await encodeHighQualityJpeg({
      width: 2,
      height: 1,
      data: new Uint8ClampedArray([
        255, 0, 0, 255,
        0, 255, 0, 255,
      ]),
    });

    let offset = 2;
    let sof = null;
    const iccChunks = new Map();
    let iccTotal = 0;
    while (offset + 4 <= jpeg.length && jpeg[offset] === 0xff) {
      while (jpeg[offset] === 0xff) offset += 1;
      const marker = jpeg[offset];
      offset += 1;
      const length = jpeg[offset] * 0x100 + jpeg[offset + 1];
      const payloadStart = offset + 2;
      const end = offset + length;
      if (marker === 0xc0 || marker === 0xc2) {
        const payload = jpeg.subarray(payloadStart, end);
        sof = {
          marker,
          height: payload[1] * 0x100 + payload[2],
          width: payload[3] * 0x100 + payload[4],
          sampling: [payload[7], payload[10], payload[13]],
        };
      }
      const identifier = new TextDecoder().decode(
        jpeg.subarray(payloadStart, payloadStart + 11),
      );
      if (
        marker === 0xe2 &&
        identifier === "ICC_PROFILE" &&
        jpeg[payloadStart + 11] === 0
      ) {
        const sequence = jpeg[payloadStart + 12];
        iccTotal = jpeg[payloadStart + 13];
        iccChunks.set(sequence, jpeg.slice(payloadStart + 14, end));
      }
      offset = end;
      if (marker === 0xda) break;
    }

    const iccLength = Array.from(iccChunks.values())
      .reduce((sum, chunkValue) => sum + chunkValue.length, 0);
    const icc = new Uint8Array(iccLength);
    let iccOffset = 0;
    for (let sequence = 1; sequence <= iccTotal; sequence += 1) {
      const chunkValue = iccChunks.get(sequence);
      icc.set(chunkValue, iccOffset);
      iccOffset += chunkValue.length;
    }
    const digest = await crypto.subtle.digest("SHA-256", icc);
    const iccSha256 = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    const bitmap = await createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }));
    const decoded = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return {
      soi: [...jpeg.subarray(0, 2)],
      eoi: [...jpeg.subarray(-2)],
      sof,
      iccCount: iccChunks.size,
      iccTotal,
      iccLength,
      iccSha256,
      decoded,
      scriptSource: document.querySelector('script[type="module"]')
        ?.getAttribute("src"),
    };
  });

  expect(result).toEqual({
    soi: [0xff, 0xd8],
    eoi: [0xff, 0xd9],
    sof: {
      marker: 0xc0,
      width: 2,
      height: 1,
      sampling: [0x11, 0x11, 0x11],
    },
    iccCount: 1,
    iccTotal: 1,
    iccLength: 3024,
    iccSha256: ICC_SHA256,
    decoded: { width: 2, height: 1 },
    scriptSource: expect.stringMatching(/^\.\/assets\//),
  });
  expect(wasmResponses).toHaveLength(1);
  expect(wasmResponses[0].status).toBe(200);
  expect(wasmResponses[0].contentType).toContain("application/wasm");
  expect(new URL(wasmResponses[0].url).origin).toBe(new URL(page.url()).origin);
  expect(new URL(wasmResponses[0].url).pathname).toMatch(/\/assets\/.+\.wasm$/);
});
