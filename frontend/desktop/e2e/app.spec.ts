import { test, expect } from "@playwright/test";

test.describe("Desktop App", () => {
  test("desktop shell loads", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "工作台" })).toBeVisible();
    await expect(page.getByRole("link", { name: "进入 Press" })).toHaveAttribute("href", "/press");
  });

  test("press project list remains available under its module path", async ({ page }) => {
    await page.goto("/press");

    await expect(page.getByRole("heading", { name: "我的项目" })).toBeVisible();
    await expect(page.getByText("还没有项目")).toBeVisible();
  });

  test("unknown routes show a recoverable error", async ({ page }) => {
    await page.goto("/nonexistent");

    await expect(page.getByRole("heading", { name: "页面不存在" })).toBeVisible();
    await expect(page.getByRole("link", { name: "返回工作台" })).toHaveAttribute("href", "/");
  });
});
