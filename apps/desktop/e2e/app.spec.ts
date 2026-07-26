import { test, expect } from "@playwright/test";

test.describe("Desktop App", () => {
  test("project list loads", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "我的项目" })).toBeVisible();
    await expect(page.getByRole("link", { name: "新建项目" })).toBeVisible();
  });

  test("empty state shows prompt", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText("还没有项目")).toBeVisible();
  });

  test("unknown routes show a recoverable error", async ({ page }) => {
    await page.goto("/nonexistent");

    await expect(page.getByRole("heading", { name: "页面加载失败" })).toBeVisible();
    await expect(page.getByRole("link", { name: "返回首页" })).toHaveAttribute(
      "href",
      "/?variant=a",
    );
  });
});
