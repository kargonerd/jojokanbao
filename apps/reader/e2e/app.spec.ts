import { test, expect } from "@playwright/test";

test.describe("Reader App", () => {
  test("homepage loads with cards", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h2").first()).toBeVisible();
    // Should show at least one publication card
    await expect(page.getByText("人民日报")).toBeVisible();
    await expect(page.getByText("参考消息")).toBeVisible();
  });

  test("navigation works", async ({ page }) => {
    await page.goto("/");
    // Click search nav item
    await page.getByText("搜索").click();
    await expect(page).toHaveURL("/search");
    // Search input should be visible
    await expect(page.getByPlaceholder("在JOJO看报上搜索")).toBeVisible();
  });

  test("support page loads", async ({ page }) => {
    await page.goto("/support");
    await expect(page.getByRole("heading", { name: "反馈" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "数据下载" })).toBeVisible();
  });

  test("404 page shows for unknown routes", async ({ page }) => {
    await page.goto("/nonexistent");
    await expect(page.getByText("404 Not Found")).toBeVisible();
  });
});
