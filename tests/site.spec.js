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

  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const focusedOutline = await page.evaluate(() => {
    const active = document.activeElement;
    const styles = getComputedStyle(active);
    return {
      style: styles.outlineStyle,
      width: Number.parseFloat(styles.outlineWidth),
    };
  });
  expect(focusedOutline.style).not.toBe("none");
  expect(focusedOutline.width).toBeGreaterThanOrEqual(2);
});
