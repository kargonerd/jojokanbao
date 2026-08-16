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

  test("root opens the reading-first homepage", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: "今天读什么？" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "资料库", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "关于", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "登录", exact: true })).toBeVisible();
    await expect(page.getByText("还没有阅读记录")).toBeVisible();
    await expect(page.getByText("Agent")).toHaveCount(0);

    const resources = await page.evaluate(() => (
      performance.getEntriesByType("resource").map((entry) => entry.name)
    ));
    expect(resources.some((url) => (
      /AccountLogin|OldsRoutes|RagRoutes|ReaderPage|pdf\.worker/.test(url)
    ))).toBe(false);
  });

  test("legacy entry keeps the previous Archive homepage available", async ({ page }) => {
    await page.goto("/legacy");
    await expect(page).toHaveURL("/archive");
    await expect(page.getByText("人民日报")).toBeVisible();
    await expect(page.getByText("参考消息")).toBeVisible();
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
    await page.goto("/support");
    await expect(page.getByRole("link", { name: "关于", exact: true })).toHaveClass(/is-active/);
    await expect(page.getByRole("heading", { name: "关于 JOJO 看报" })).toBeVisible();
    await expect(page.getByRole("link", { name: "打开旧版 JOJO 看报" })).toHaveAttribute("href", "/legacy");
    await expect(page.getByRole("link", { name: "GitHub 查看源码" })).toHaveCount(0);
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
    for (const path of ["/rag", "/olds"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: "404 Not Found" })).toBeVisible();
    }
  });

  test("404 page shows for unknown routes", async ({ page }) => {
    await page.goto("/nonexistent");
    await expect(page.getByText("404 Not Found")).toBeVisible();
  });
});
