// @vitest-environment node

import { beforeEach, expect, it, vi } from "vitest";

const encodeMock = vi.hoisted(() => vi.fn());
const initMock = vi.hoisted(() => vi.fn());

vi.mock("@jsquash/jpeg/encode.js", () => ({
  default: encodeMock,
  init: initMock,
}));

beforeEach(() => {
  vi.resetModules();
  encodeMock.mockReset();
  initMock.mockReset();
});

it("shares one in-flight JPEG encoder readiness promise", async () => {
  let release!: (value: ArrayBuffer) => void;
  encodeMock.mockReturnValue(new Promise<ArrayBuffer>((resolve) => {
    release = resolve;
  }));
  const { prepareHighQualityJpegEncoder } =
    await import("../../src/core/conversion/jpeg");
  const first = prepareHighQualityJpegEncoder();
  const second = prepareHighQualityJpegEncoder();
  expect(first).toBe(second);
  expect(initMock).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(encodeMock).toHaveBeenCalledOnce());
  release(new ArrayBuffer(0));
  await expect(first).resolves.toBeUndefined();
});

it("maps initialization failure and re-initializes on retry", async () => {
  const failure = new Error("WASM unavailable");
  encodeMock
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(new ArrayBuffer(0));
  const { prepareHighQualityJpegEncoder } =
    await import("../../src/core/conversion/jpeg");

  await expect(prepareHighQualityJpegEncoder()).rejects.toMatchObject({
    code: "ENCODE_FAILED",
    cause: failure,
  });
  await expect(prepareHighQualityJpegEncoder()).resolves.toBeUndefined();
  expect(initMock).toHaveBeenCalledTimes(2);
  expect(encodeMock).toHaveBeenCalledTimes(2);
});
