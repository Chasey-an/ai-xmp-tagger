import { expect, test } from "@playwright/test";

test("renders the minimal browser app foundation", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "AI 图片 XMP 批量处理",
    }),
  ).toBeVisible();
  await expect(page.locator("main")).toHaveCount(1);
});
