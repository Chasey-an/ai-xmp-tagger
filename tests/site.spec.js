import { expect, test } from "@playwright/test";

const heading = "AI XMP Tagger";

test("320px layout keeps the primary download path visible without overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "下载 Mac 版（Apple 芯片）" }).first(),
  ).toBeVisible();
  await expect(page.getByText("安装包暂未签名。").first()).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
});

test("downloads are touch-sized and the skip link is first in keyboard order", async ({
  page,
}) => {
  await page.goto("/");

  const firstDownload = page
    .getByRole("link", { name: "下载 Mac 版（Apple 芯片）" })
    .first();
  expect((await firstDownload.boundingBox())?.height).toBeGreaterThanOrEqual(44);

  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
  await expect(page.locator(".skip-link")).toBeVisible();
});

test("product walkthrough uses six native-size descriptive PNGs with intentional loading", async ({
  page,
}) => {
  await page.goto("/");

  const screenshots = page.locator("#screenshots img, .hero-preview img");
  await expect(screenshots).toHaveCount(6);
  expect(
    await screenshots.evaluateAll((images) =>
      images.map((image) => image.getAttribute("src")),
    ),
  ).toEqual([
    "./images/app-home.png",
    "./images/app-modes.png",
    "./images/app-input.png",
    "./images/app-results.png",
    "./images/app-report.png",
    "./images/xmp-verification.png",
  ]);
  await expect(screenshots.nth(2)).toHaveAttribute(
    "alt",
    /同时添加单个中性测试图片和测试文件夹/,
  );
  await expect(screenshots.nth(3)).toHaveAttribute(
    "alt",
    /两张中性测试图片/,
  );

  for (let index = 0; index < 6; index += 1) {
    const image = screenshots.nth(index);
    const alt = (await image.getAttribute("alt"))?.trim() ?? "";
    expect(alt, `image ${index + 1} should have descriptive alt text`).not.toBe(
      "",
    );
    await expect(image).toHaveAttribute("width", "1440");
    await expect(image).toHaveAttribute("height", "900");
    await expect(image).toHaveAttribute("decoding", "async");
    if (index === 0) {
      await expect(image).toHaveAttribute("loading", "eager");
    } else {
      await expect(image).toHaveAttribute("loading", "lazy");
    }
  }

  for (let index = 0; index < 6; index += 1) {
    const image = screenshots.nth(index);
    if (index > 0) {
      await image.scrollIntoViewIfNeeded();
    }
    await expect
      .poll(() =>
        image.evaluate((element) => ({
          complete: element.complete,
          naturalWidth: element.naturalWidth,
          naturalHeight: element.naturalHeight,
        })),
      )
      .toEqual({
        complete: true,
        naturalWidth: 1440,
        naturalHeight: 900,
      });
  }
});

test("content and release links work when JavaScript is disabled", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:4173/");

  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  await expect(page.locator("main")).toContainText("三种处理模式");
  const windowsHref = await page
    .getByRole("link", { name: "下载 Windows 版（64 位）" })
    .first()
    .getAttribute("href");
  expect(windowsHref).toMatch(
    /^https:\/\/github\.com\/local\/ai-xmp-tagger\/releases\/download\//,
  );

  await context.close();
});

test("document identity and internal navigation are semantic", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/AI XMP Tagger.*Amazon 卖家.*XMP 标签/);
  await expect(page.locator("h1")).toHaveCount(1);

  const internalLinks = page.locator('a[href^="#"]');
  for (let index = 0; index < (await internalLinks.count()); index += 1) {
    const href = await internalLinks.nth(index).getAttribute("href");
    expect(href).toBeTruthy();
    await expect(page.locator(href)).toHaveCount(1);
  }
});

test("workflow numbers are decorative while the ordered list carries order", async ({
  page,
}) => {
  await page.goto("/");

  const workflow = page.locator("#workflow");
  await expect(workflow.locator("ol.steps")).toHaveCount(1);
  await expect(workflow.locator("ol.steps > li")).toHaveCount(6);
  const decorativeNumbers = workflow.locator("ol.steps > li > span");
  await expect(decorativeNumbers).toHaveCount(6);
  for (let index = 0; index < 6; index += 1) {
    await expect(decorativeNumbers.nth(index)).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  }
});

test("interactive targets are touch-sized and show a keyboard focus indicator", async ({
  page,
}) => {
  await page.goto("/");

  const targets = page.locator(
    "a.button, a.text-link, nav a, details > summary, button",
  );
  const targetCount = await targets.count();
  expect(targetCount).toBeGreaterThan(0);
  for (let index = 0; index < targetCount; index += 1) {
    const target = targets.nth(index);
    const box = await target.boundingBox();
    expect(box?.height, `target ${index} should be at least 44px tall`).toBeGreaterThanOrEqual(
      44,
    );
  }

  const representativeTargets = [
    page.getByRole("link", { name: "处理模式", exact: true }),
    page
      .getByRole("link", { name: "下载 Mac 版（Apple 芯片）", exact: true })
      .first(),
    page.locator(".hero .text-link", { hasText: "Intel Mac 下载" }),
    page.locator(".checksums > summary"),
  ];
  for (const target of representativeTargets) {
    await target.focus();
    await expect(target).toBeFocused();
    const focusedOutline = await target.evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        style: styles.outlineStyle,
        width: Number.parseFloat(styles.outlineWidth),
      };
    });
    expect(focusedOutline.style).not.toBe("none");
    expect(focusedOutline.width).toBeGreaterThanOrEqual(2);
  }
});

test("FAQ disclosure decoration stays out of accessible names", async ({
  page,
}) => {
  await page.goto("/");

  const summaries = page.locator("#faq > details > summary");
  const expectedNames = [
    "支持哪些图片格式？",
    "一次可以处理多少文件？",
    "JPG 会不会损失清晰度？",
    "处理后的文件在哪里？",
    "怎样确认 XMP 已正确写入？",
    "为什么系统提示无法验证开发者",
    "工具会自动判断图片是不是 AI 生成吗",
  ];
  await expect(summaries).toHaveCount(7);
  for (let index = 0; index < 7; index += 1) {
    const summary = summaries.nth(index);
    await expect(summary.locator(".disclosure-icon")).toHaveCount(1);
    await expect(summary.locator(".disclosure-icon")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(summary).toHaveAccessibleName(expectedNames[index]);
  }
});

test("copy controls copy each checksum and show success feedback", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value) => {
          window.__copiedChecksums ??= [];
          window.__copiedChecksums.push(value);
        },
      },
    });
  });
  await page.goto("/");

  const hashes = page.locator(".checksums code");
  const buttons = page.locator(".checksums .copy-hash");
  await expect(hashes).toHaveCount(3);
  await expect(buttons).toHaveCount(3);
  await page.locator(".checksums > summary").click();

  const accessibleNames = [
    "复制 Mac（Apple 芯片）SHA-256",
    "复制 Mac（Intel）SHA-256",
    "复制 Windows（64 位）SHA-256",
  ];
  for (let index = 0; index < 3; index += 1) {
    const button = buttons.nth(index);
    const expectedHash = (await hashes.nth(index).textContent())?.trim();

    await expect(button).toHaveAccessibleName(accessibleNames[index]);
    await button.click();
    await expect(button).toHaveText("已复制");
    await expect(button).toHaveAccessibleName(accessibleNames[index]);
    await expect(
      page.locator(".checksums .copy-status").nth(index),
    ).toContainText("已复制");
    await expect
      .poll(() =>
        page.evaluate(
          (copiedIndex) => window.__copiedChecksums?.[copiedIndex],
          index,
        ),
      )
      .toBe(expectedHash);
    await expect(button).toHaveText("复制", { timeout: 2_400 });
    await expect(button).toHaveAccessibleName(accessibleNames[index]);
  }
});

test("copy controls recover from Clipboard API failure without an unhandled error", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("clipboard unavailable");
        },
      },
    });
  });
  await page.goto("/");

  const button = page.locator(".checksums .copy-hash").first();
  await page.locator(".checksums > summary").click();
  await expect(button).toHaveAccessibleName(
    "复制 Mac（Apple 芯片）SHA-256",
  );
  await button.click();
  await expect(button).toHaveText("复制");
  await expect(button).toHaveAccessibleName(
    "复制 Mac（Apple 芯片）SHA-256",
  );
  await expect(page.locator(".checksums .copy-status").first()).toHaveText(
    "复制失败，请手动复制",
  );
  expect(pageErrors).toEqual([]);
});
