import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const nativeSource = ts.transpileModule(readFileSync(new URL("../../mobile/src/lib/bookDocument.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const nativeDocument = {} as typeof import("../../mobile/src/lib/bookDocument");
new Function("exports", "require", nativeSource)(nativeDocument,
  createRequire(new URL("../../mobile/src/lib/bookDocument.ts", import.meta.url)));
const { createBookDocument } = nativeDocument;

const uiCss = readFileSync(new URL("../../packages/ui/styles/index.css", import.meta.url), "utf8");
const readerCss = readFileSync(new URL("../src/rag/components/BookReader.css", import.meta.url), "utf8");
const body = '<p>因为有矛盾存<a id="page16">在。他把辩证法改造成为唯物辩证法。</a></p><p><a href="#page16" id="real-link">页码链接</a></p>';

test("source and generated chapter titles use the same typography while note links still work", async ({ page }) => {
  await page.setContent(`<style>${uiCss}\nh1{font-size:inherit;font-weight:inherit}\n${readerCss}\narticle{font-size:24px}</style>
    <article><h1 id="generated" class="book-chapter-title">在郑州会议上的讲话（节选）</h1>
    <div class="prose-editorial"><h1 id="original" class="book-chapter-title">非洲当前的任务是反对帝国主义，不是反对资本主义<a id="ref" href="#note"><sup>[1]</sup></a></h1>
    <h2 id="subheading">正文小标题</h2><p id="note">原注<a href="#ref">返回</a></p></div></article>`);
  const typography = (selector: string) => page.locator(selector).evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.fontSize, style.fontWeight, style.lineHeight, style.letterSpacing, style.marginTop, style.marginBottom];
  });
  expect(await typography("#original")).toEqual(await typography("#generated"));
  await expect(page.locator("#original")).toHaveCSS("font-size", "48px");
  expect(await page.locator("#subheading").evaluate((element) => getComputedStyle(element).fontSize)).not.toBe("48px");
  await page.locator("#ref").click();
  await expect(page).toHaveURL(/#note$/);
  await page.locator("#note a").click();
  await expect(page).toHaveURL(/#ref$/);
});

test("native chapter heading keeps its note link without printing the title twice", async ({ page }) => {
  const title = "非洲当前的任务是反对帝国主义，不是反对资本主义";
  await page.setContent(createBookDocument({
    fragment: { formatVersion: "jojo-fragment/1", itemId: "test", fragmentId: "chapter:726", type: "chapter", order: 1, title,
      body: { format: "html", value: `<h1>${title}<a id="ref1" href="#note1"><sup>[1]</sup></a></h1><p id="note1">原注<a href="#ref1">返回</a></p>` }, assetRefs: [], annotations: [] },
    assetUrls: {}, textScale: 1, lineHeight: 2, firstLineIndent: true,
    eInk: false, readingMode: "scroll", paperColor: "ivory",
  }));
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator("h1")).toHaveText(`${title}[1]`);
  await page.locator("#ref1").click();
  await expect(page).toHaveURL(/#note1$/);
  await page.locator('#note1 a').click();
  await expect(page).toHaveURL(/#ref1$/);
});

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
