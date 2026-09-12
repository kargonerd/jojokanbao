import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const nativeSource = ts.transpileModule(readFileSync(new URL("../../mobile/src/lib/bookDocument.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const nativeDocument = {} as typeof import("../../mobile/src/lib/bookDocument");
new Function("exports", nativeSource)(nativeDocument);
const { createBookDocument } = nativeDocument;

const uiCss = readFileSync(new URL("../../packages/ui/styles/index.css", import.meta.url), "utf8");
const readerCss = readFileSync(new URL("../src/rag/components/BookReader.css", import.meta.url), "utf8");
const body = '<p>因为有矛盾存<a id="page16">在。他把辩证法改造成为唯物辩证法。</a></p><p><a href="#page16" id="real-link">页码链接</a></p>';

for (const ink of ["#202020", "#eeeeee"]) {
  test(`web page anchors inherit ${ink} even on hover while links retain their color`, async ({ page }) => {
    await page.setContent(`<style>${uiCss}\n${readerCss}\n:root{--color-red:#8b1a1a;--color-red-dark:#701515}article{color:${ink}}</style><article class="prose-editorial">${body}</article>`);
    const color = await page.locator("article").evaluate((el) => getComputedStyle(el).color);
    await expect(page.locator("#page16")).toHaveCSS("color", color);
    await page.locator("#page16").hover();
    await expect(page.locator("#page16")).toHaveCSS("color", color);
    await expect(page.locator("#real-link")).toHaveCSS("color", "rgb(139, 26, 26)");
    await page.locator("#real-link").click();
    await expect(page).toHaveURL(/#page16$/);
  });
}

for (const paperColor of ["ivory", "dark"] as const) {
  test(`native ${paperColor} book page anchors have body color`, async ({ page }) => {
    await page.setContent(createBookDocument({
      fragment: { formatVersion: "jojo-fragment/1", itemId: "test", fragmentId: "chapter:1", type: "chapter", order: 1, title: "正文", body: { format: "html", value: body }, assetRefs: [], annotations: [] },
      assetUrls: {}, textScale: 1, lineHeight: 2, firstLineIndent: true,
      eInk: false, readingMode: "scroll", paperColor,
    }));
    const color = await page.locator("article").evaluate((el) => getComputedStyle(el).color);
    await expect(page.locator("#page16")).toHaveCSS("color", color);
    expect(await page.locator("#real-link").evaluate((el) => getComputedStyle(el).color)).not.toBe(color);
  });
}
