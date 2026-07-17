import { test, expect } from "@playwright/test";

test.describe("Reader App", () => {
  test("serves PDF.js runtime assets from the Reader origin", async ({ request }) => {
    for (const asset of [
      "/assets/pdfjs/cmaps/Adobe-CNS1-UCS2.bcmap",
      "/assets/pdfjs/wasm/openjpeg.wasm",
      "/assets/pdfjs/standard_fonts/LiberationSans-Regular.ttf",
    ]) {
      const response = await request.get(asset);
      expect(response.ok(), asset).toBe(true);
      expect((await response.body()).byteLength, asset).toBeGreaterThan(1_000);
    }
  });

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
