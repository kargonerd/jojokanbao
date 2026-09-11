import { test, expect } from "@playwright/test";

test.describe("JOJO Web", () => {
  test.beforeEach(async ({ page }) => {
    // Keep ordinary homepage checks independent of the seasonal opening.
    await page.clock.setFixedTime(new Date("2026-10-01T00:00:00+08:00"));
  });

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
      /AccountLogin|TimesRoutes|RagRoutes|ReaderPage|pdf\.worker/.test(url)
    ))).toBe(false);
  });

  test("production CSS keeps component-specific input states", async ({ page }) => {
    await page.goto("/");
    const homeSearch = page.getByPlaceholder("搜索书名");
    await expect(homeSearch).toHaveCSS("border-top-width", "0px");
    await expect(homeSearch).toHaveCSS("border-right-width", "0px");
    await expect(homeSearch).toHaveCSS("border-bottom-width", "0px");
    await expect(homeSearch).toHaveCSS("border-left-width", "0px");
    await homeSearch.click();
    await expect(homeSearch).toHaveCSS("outline-style", "none");
    await expect(homeSearch).toHaveCSS("box-shadow", "none");
    await expect(page.locator(".app-search-box")).toHaveCSS("border-top-color", "rgb(139, 26, 26)");

    await page.goto("/account");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    const email = page.getByPlaceholder("name@example.com");
    await expect(email).toHaveCSS("border-top-width", "0px");
    await expect(email).toHaveCSS("border-right-width", "0px");
    await expect(email).toHaveCSS("border-bottom-width", "1px");
    await expect(email).toHaveCSS("border-left-width", "0px");
    await expect(email).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  });

  for (const path of ["/", "/library"]) {
    for (const inputMethod of ["pointer", "keyboard"]) {
      test(`search focus feedback at ${path} with ${inputMethod}`, async ({ page }) => {
        await page.goto(path);
        const searchBox = page.locator(".app-search-box");
        const searchInput = searchBox.getByRole("searchbox");
        await expect(searchInput).toBeVisible();
        await expect(searchBox).toHaveCSS("box-shadow", "none");

        if (inputMethod === "pointer") {
          await searchInput.click();
        } else {
          // Leave the input, then enter it through real keyboard navigation.
          await searchInput.focus();
          await searchInput.press("Shift+Tab");
          await expect(searchInput).not.toBeFocused();
          await page.keyboard.press("Tab");
        }

        await expect(searchInput).toBeFocused();
        await expect(searchInput).toHaveCSS("outline-style", "none");
        await expect(searchInput).toHaveCSS("box-shadow", "none");
        // The enclosing control supplies a visible focus indicator for both
        // pointer and keyboard users; removing the inner ring must retain it.
        await expect(searchBox).toHaveCSS("border-top-color", "rgb(139, 26, 26)");
        await expect(searchBox).toHaveCSS("box-shadow", "rgba(139, 26, 26, 0.14) 4px 4px 0px 0px");
      });
    }
  }

  test("legacy entry returns to the redesigned homepage", async ({ page }) => {
    await page.goto("/legacy");
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: "今天读什么？" })).toBeVisible();
  });

  test("navigation works", async ({ page }) => {
    await page.goto("/");
    // Click search nav item
    await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "搜索", exact: true }).click();
    await expect(page).toHaveURL("/search");
    // Search input should be visible
    await expect(page.getByRole("textbox", { name: "全文检索关键词" })).toBeVisible();
    await expect(page.locator("[data-search-scroll-container]")).toHaveCSS("background-color", "rgb(244, 244, 242)");
  });

  test("support page loads", async ({ page }) => {
    await page.goto("/support");
    await expect(page.getByRole("link", { name: "关于", exact: true })).toHaveClass(/is-active/);
    await expect(page.getByRole("heading", { name: "关于 JOJO 看报" })).toBeVisible();
    await expect(page.getByRole("link", { name: "打开旧版 JOJO 看报" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "GitHub 查看源码" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "版权说明" })).toBeVisible();

    const quarkLinks = page.getByRole("link", { name: "夸克网盘下载", exact: true });
    await expect(quarkLinks).toHaveCount(5);
    for (const link of [page.getByRole("link", { name: "JOJO看报账号", exact: true }), quarkLinks.first()]) {
      await expect(link).toHaveCSS("color", "rgb(32, 32, 32)");
      await expect(link).toHaveCSS("text-decoration-line", "underline");
    }
    const license = page.getByRole("link", { name: /开源软件许可/ });
    await expect(license).toHaveCSS("color", "rgb(32, 32, 32)");
    await expect(license.locator("strong")).toHaveCSS("text-decoration-line", "underline");
    await license.focus();
    await license.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(license).toBeFocused();
    await expect(license).toHaveCSS("color", "rgb(139, 26, 26)");
    await expect(license).toHaveCSS("outline-style", "solid");
    await expect(license).toHaveCSS("outline-width", "2px");
  });

  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    test(`support section links scroll into view at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      for (const path of ["/support", "/archive/support"]) {
        const copyrightUrl = `${path}#${encodeURIComponent("版权说明")}`;
        const copyright = page.getByRole("heading", { name: "版权说明", exact: true });

        await page.goto(copyrightUrl);
        await expect(copyright).toBeInViewport({ ratio: 1 });
        expect((await copyright.boundingBox())!.y).toBeGreaterThanOrEqual(64);

        await page.reload();
        await expect(copyright).toBeInViewport({ ratio: 1 });

        await page.goto(`${path}#${encodeURIComponent("纪念缅怀")}`);
        await expect(page.getByRole("heading", { name: "纪念缅怀", exact: true })).toBeInViewport({ ratio: 1 });
        await page.goBack();
        await expect(copyright).toBeInViewport({ ratio: 1 });
      }
    });
  }

  test("support page tolerates unknown and malformed fragments", async ({ page }) => {
    for (const hash of ["#unknown-section", "#%E0%A4%A"]) {
      await page.goto(`/support${hash}`);
      await expect(page.getByRole("heading", { name: "关于 JOJO 看报", exact: true })).toBeVisible();
    }
  });

  test("legacy publication links redirect without losing the page hash", async ({ page }) => {
    await page.goto("/rmrb/19761009#page-5");
    await expect(page).toHaveURL(/\/archive\/rmrb\/19761009#page-5$/);
  });

  test("the superseded /reader prefix redirects to Archive", async ({ page }) => {
    await page.goto("/reader/hq/196419?from=preview#page-2");
    await expect(page).toHaveURL(/\/archive\/hq\/196419\?from=preview#page-2$/);
  });

  test("local AI and Times routes require login", async ({ page }) => {
    await page.goto("/rag");
    await expect(page).toHaveURL(/\/account\?returnTo=%2Frag$/);
    await expect(page.getByRole("heading", { name: /读者入口|登录暂不可用/ })).toBeVisible();

    await page.goto("/times");
    await expect(page).toHaveURL(/\/account\?returnTo=%2Ftimes$/);
    await expect(page.getByRole("heading", { name: /读者入口|登录暂不可用/ })).toBeVisible();
  });

  test("404 page shows for unknown routes", async ({ page }) => {
    await page.goto("/nonexistent");
    await expect(page.getByText("404 Not Found")).toBeVisible();
  });
});
