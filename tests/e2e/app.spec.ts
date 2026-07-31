import { expect, test } from "@playwright/test";

import {
  assertMagic,
  captureDownload,
  chooseMode,
  countExactTarget,
  extractJpegScan,
  fixtureBytes,
  processUploaded,
  sha256,
  upload,
} from "./helpers";

test("renders the local-only workbench with the documented default mode", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "在浏览器批量添加 AI 生成人物 XMP 标签",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "转为 JPG 并写入标签" }),
  ).toBeChecked();
  await expect(page.getByText("图片只在当前浏览器处理，不会上传服务器")).toBeVisible();
  await expect(page.locator("main")).toHaveCount(1);
});

test("default mode converts PNG to a tagged JPEG downloadable from the real UI", async ({
  page,
}) => {
  await page.goto("/");
  await upload(page, ["neutral-1x1.png"]);
  await processUploaded(page);
  const row = page.locator("tbody tr").filter({ hasText: "neutral-1x1.png" });
  await expect(row).toContainText("✓ 成功");
  await expect(row).toContainText("✓ 包含");
  const output = await captureDownload(page, "下载处理后的图片");
  expect(output.filename).toBe("neutral-1x1_xmp.jpg");
  assertMagic(output.filename, output.bytes);
  expect(countExactTarget(output.bytes)).toBe(1);
});

for (const fixture of ["neutral-1x1.png", "neutral-1x1.webp"] as const) {
  test(`original mode keeps ${fixture.split(".").at(-1)} format and writes one exact tag`, async ({
    page,
  }) => {
    await page.goto("/");
    await chooseMode(page, "保持原格式并写入标签");
    await upload(page, [fixture]);
    await processUploaded(page);
    const row = page.locator("tbody tr").filter({ hasText: fixture });
    await expect(row).toContainText("✓ 成功");
    const output = await captureDownload(page, "下载处理后的图片");
    expect(output.filename).toBe(
      fixture.replace(/(\.[^.]+)$/u, "_xmp$1"),
    );
    assertMagic(output.filename, output.bytes);
    expect(countExactTarget(output.bytes)).toBe(1);
  });
}

test("verify-only checks JPEG, PNG and WebP without exposing an image download", async ({
  page,
}) => {
  await page.goto("/");
  await chooseMode(page, "只检查 XMP 标签");
  await upload(page, [
    "neutral-1x1.jpg",
    "neutral-1x1.png",
    "neutral-1x1.webp",
  ]);
  await processUploaded(page);
  await expect(page.locator("tbody tr")).toHaveCount(3);
  for (const fixture of [
    "neutral-1x1.jpg",
    "neutral-1x1.png",
    "neutral-1x1.webp",
  ]) {
    await expect(
      page.locator("tbody tr").filter({ hasText: fixture }),
    ).toContainText("✓ 已检查");
  }
  await expect(page.getByText(/已检查 3/u)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /下载处理后的图片|下载 \d+ 个成功文件/u }),
  ).toHaveCount(0);
});

for (const mode of [
  "保持原格式并写入标签",
  "只检查 XMP 标签",
] as const) {
  test(`BMP is an isolated failure in ${mode}`, async ({ page }) => {
    await page.goto("/");
    await chooseMode(page, mode);
    await upload(page, ["neutral-1x1.bmp"]);
    await processUploaded(page);
    const row = page.locator("tbody tr").filter({ hasText: "neutral-1x1.bmp" });
    await expect(row).toContainText("× 失败");
    await expect(row).toContainText("BMP");
  });
}

test("default JPEG write preserves the independently hashed entropy-coded scan", async ({
  page,
}) => {
  const source = await fixtureBytes("neutral-1x1.jpg");
  const sourceScanHash = sha256(extractJpegScan(source));
  expect(sourceScanHash).not.toBe(sha256(source));

  await page.goto("/");
  await upload(page, ["neutral-1x1.jpg"]);
  await processUploaded(page);
  const output = await captureDownload(page, "下载处理后的图片");
  expect(output.filename).toBe("neutral-1x1_xmp.jpg");
  expect(sha256(extractJpegScan(output.bytes))).toBe(sourceScanHash);
  expect(countExactTarget(output.bytes)).toBe(1);
});

test("cancelling a WASM-blocked conversion deterministically cancels queued files", async ({
  page,
}) => {
  const wasmPattern = "**/*.wasm";
  let wasmIntercepted = false;
  let wasmHandlerFinished = false;
  let releaseWasm!: () => void;
  const wasmRelease = new Promise<void>((resolve) => {
    releaseWasm = resolve;
  });
  const wasmRouteHandler: Parameters<typeof page.route>[1] = async (route) => {
    wasmIntercepted = true;
    try {
      await wasmRelease;
      await route.continue();
    } finally {
      wasmHandlerFinished = true;
    }
  };
  await page.route(wasmPattern, wasmRouteHandler);

  try {
    await page.goto("/");
    await upload(page, [
      { fixture: "neutral-1x1.png", name: "queued-1.png" },
      { fixture: "neutral-1x1.png", name: "queued-2.png" },
      { fixture: "neutral-1x1.png", name: "queued-3.png" },
      { fixture: "neutral-1x1.png", name: "queued-4.png" },
    ]);
    await page.getByRole("button", { name: "开始处理" }).click();
    await expect
      .poll(() => wasmIntercepted, {
        message: "MozJPEG WASM request must reach the cancellation barrier",
        timeout: 10_000,
      })
      .toBe(true);
    await page.getByRole("button", { name: "取消处理" }).click();
    releaseWasm();

    await expect(page.getByRole("heading", { name: "处理结果" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator("tbody tr")).toHaveCount(4);
    await expect(page.locator("tbody tr")).toContainText([
      /已取消/u,
      /已取消/u,
      /已取消/u,
      /已取消/u,
    ]);
    await expect(page.getByText(/已取消 4/u)).toBeVisible();
  } finally {
    releaseWasm();
    try {
      if (wasmIntercepted) {
        await expect
          .poll(() => wasmHandlerFinished, {
            message: "blocked WASM route handler must be released",
            timeout: 5_000,
          })
          .toBe(true);
      }
    } finally {
      await page.unroute(wasmPattern, wasmRouteHandler);
    }
  }
});

test("beforeunload warning exists only for successful undownloaded outputs", async ({
  page,
}) => {
  const dispatchBeforeUnload = () =>
    page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      return window.dispatchEvent(event);
    });

  await page.goto("/");
  expect(await dispatchBeforeUnload()).toBe(true);
  await upload(page, ["neutral-1x1.jpg"]);
  await processUploaded(page);
  expect(await dispatchBeforeUnload()).toBe(false);

  await captureDownload(page, "下载处理后的图片");
  expect(await dispatchBeforeUnload()).toBe(true);

  await page.getByRole("button", { name: "新建批次" }).click();
  expect(await dispatchBeforeUnload()).toBe(true);
  await expect(page.getByRole("heading", { name: "处理结果" })).toHaveCount(0);
});
