// @vitest-environment node

import { expect, it, vi } from "vitest";

const decodedData = vi.hoisted(() =>
  new Uint8ClampedArray([10, 20, 30, 128]));

vi.mock("../../src/core/conversion/bmp", () => ({
  decodeBmp: () => ({ data: decodedData, width: 1, height: 1 }),
}));

import { decodeRaster } from "../../src/core/conversion/decode";

it("white-composes BMP pixels in the decoder buffer without another allocation", async () => {
  const bytes = new Uint8Array([1]);
  const file = {
    arrayBuffer: async () => bytes.buffer,
  } as File;
  const image = await decodeRaster(file, "bmp");
  expect(image.data).toBe(decodedData);
  expect([...image.data]).toEqual([132, 137, 142, 255]);
});
