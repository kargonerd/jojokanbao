import { test, expect } from "@playwright/test";

test.describe("Press App", () => {
  test("homepage loads with header", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("JOJO Press")).toBeVisible();
    await expect(page.getByText("新建项目")).toBeVisible();
  });

  test("empty state shows prompt", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("暂无项目")).toBeVisible();
  });

  test("unknown routes redirect to home", async ({ page }) => {
    await page.goto("/nonexistent");
    await expect(page).toHaveURL("/");
  });
});
