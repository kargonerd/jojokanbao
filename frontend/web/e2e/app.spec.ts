import { test, expect } from "@playwright/test";

test.describe("JOJO Web", () => {
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

  test("root redirects to the Archive homepage", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL("/archive");
    await expect(page.locator("h2").first()).toBeVisible();
    await expect(page.getByText("人民日报")).toBeVisible();
    await expect(page.getByText("参考消息")).toBeVisible();

    const resources = await page.evaluate(() => (
      performance.getEntriesByType("resource").map((entry) => entry.name)
    ));
    expect(resources.some((url) => (
      /AccountLogin|OldsRoutes|RagRoutes|ReaderPage|pdf\.worker/.test(url)
    ))).toBe(false);
  });

  test("navigation works", async ({ page }) => {
    await page.goto("/archive");
    // Click search nav item
    await page.getByText("搜索").click();
    await expect(page).toHaveURL("/archive/search");
    // Search input should be visible
    await expect(page.getByPlaceholder("在JOJO看报上搜索")).toBeVisible();
  });

  test("support page loads", async ({ page }) => {
    await page.goto("/archive/support");
    await expect(page.getByRole("heading", { name: "反馈" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "数据下载" })).toBeVisible();
  });

  test("legacy publication links redirect without losing the page hash", async ({ page }) => {
    await page.goto("/rmrb/19761009#page-5");
    await expect(page).toHaveURL(/\/archive\/rmrb\/19761009#page-5$/);
  });

  test("the superseded /reader prefix redirects to Archive", async ({ page }) => {
    await page.goto("/reader/hq/196419?from=preview#page-2");
    await expect(page).toHaveURL(/\/archive\/hq\/196419\?from=preview#page-2$/);
  });

  test("unfinished modules remain disabled", async ({ page }) => {
    for (const path of ["/account", "/rag", "/olds"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: "404 Not Found" })).toBeVisible();
    }
  });

  test("404 page shows for unknown routes", async ({ page }) => {
    await page.goto("/nonexistent");
    await expect(page.getByText("404 Not Found")).toBeVisible();
  });
});
