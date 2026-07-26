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
