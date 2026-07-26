import { expect, test } from "@playwright/test";

test("renders the minimal browser app foundation", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "批量添加 AI 生成人物 XMP 标签",
    }),
  ).toBeVisible();
  await expect(page.locator("main")).toHaveCount(1);
});
