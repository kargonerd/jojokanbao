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
const { bookChapterAnchorId, createBookDocument } = nativeDocument;

const uiCss = readFileSync(new URL("../../packages/ui/styles/index.css", import.meta.url), "utf8");
const readerCss = readFileSync(new URL("../src/rag/components/BookReader.css", import.meta.url), "utf8");
const annotationCss = readFileSync(new URL("../src/annotations/annotations.css", import.meta.url), "utf8");
const anchorDomSource = ts.transpileModule(readFileSync(new URL("../src/annotations/domAnchors.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
type AnchorDomWindow = Window & { anchorDom: typeof import("../src/annotations/domAnchors") };
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
  const reference = page.locator('[data-reader-anchor-id="ref1"]');
  const note = page.locator('[data-reader-anchor-id="note1"]');
  await expect(reference).toHaveAttribute("id", bookChapterAnchorId("chapter:726", "ref1"));
  await expect(note).toHaveAttribute("id", bookChapterAnchorId("chapter:726", "note1"));
  await reference.click();
  await expect.poll(() => page.evaluate(() => decodeURIComponent(location.hash.slice(1)))).toBe(bookChapterAnchorId("chapter:726", "note1"));
  await note.locator("a").click();
  await expect.poll(() => page.evaluate(() => decodeURIComponent(location.hash.slice(1)))).toBe(bookChapterAnchorId("chapter:726", "ref1"));
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
    const pageAnchor = page.locator('[data-reader-anchor-id="page16"]');
    const pageLink = page.locator('[data-reader-anchor-id="real-link"]');
    await expect(pageAnchor).toHaveAttribute("id", bookChapterAnchorId("chapter:1", "page16"));
    await expect(pageAnchor).toHaveCSS("color", color);
    await pageAnchor.hover();
    await expect(pageAnchor).toHaveCSS("color", color);
    expect(await pageLink.evaluate((el) => getComputedStyle(el).color)).not.toBe(color);
    await pageLink.click();
    await expect.poll(() => page.evaluate(() => decodeURIComponent(location.hash.slice(1)))).toBe(bookChapterAnchorId("chapter:1", "page16"));
  });
}

for (const paperColor of ["white", "ivory", "dark"] as const) {
  test(`native ${paperColor} personal marks retain a wavy underline instead of a solid border`, async ({ page }) => {
    await page.setContent(createBookDocument({
      fragment: { formatVersion: "jojo-fragment/1", itemId: "test", fragmentId: "chapter:1", type: "chapter", order: 1, title: "正文", body: { format: "html", value: '<p><mark data-annotation-id="own-note">自己划线的正文</mark></p>' }, assetRefs: [], annotations: [] },
      assetUrls: {}, textScale: 1, lineHeight: 2, firstLineIndent: true, eInk: false, readingMode: "scroll", paperColor,
    }));
    const mark = page.locator('mark[data-annotation-id="own-note"]');
    await expect(mark).toHaveCSS("text-decoration-style", "wavy");
    await expect(mark).toHaveCSS("text-decoration-line", "underline");
    await expect(mark).toHaveCSS("border-bottom-style", "none");
    await expect(mark).toHaveCSS("text-decoration-color", paperColor === "dark" ? "rgb(212, 102, 102)" : "rgb(139, 26, 26)");
  });
}

test("web personal underlines remain wavy for cloud and older local marks", async ({ page }) => {
  await page.setContent(`<style>${uiCss}\n${readerCss}\n${annotationCss}</style><article class="prose-editorial"><p><mark class="content-annotation-mark" data-underlined-by-me="true">云端划线</mark><mark class="book-reader-user-underline">本地划线</mark></p></article>`);
  for (const selector of [".content-annotation-mark", ".book-reader-user-underline"]) {
    await expect(page.locator(selector)).toHaveCSS("text-decoration-style", "wavy");
    await expect(page.locator(selector)).toHaveCSS("text-decoration-line", "underline");
    await expect(page.locator(selector)).toHaveCSS("box-shadow", "none");
  }
});

for (const nesting of ["search contains underline", "underline contains search"] as const) {
  test(`clearing a book location highlight leaves only the saved underline: ${nesting}`, async ({ page }) => {
    await page.setContent(`<style>${uiCss}\n${readerCss}\n${annotationCss}\n:root{--color-red:#8b1a1a;--color-ink:#202020}</style><article class="prose-editorial"><p>前文<mark data-book-search-target="true" data-test-location>中国<a id="source-anchor">人</a></mark>后文<a href="#footnote">原注</a><mark data-book-search-target="true" id="other-result">别处</mark><mark data-reader-explanation="true">解释</mark></p><p id="footnote">注释</p></article>`);
    await page.addScriptTag({ content: `{ const exports = {}; ${anchorDomSource}\nwindow.anchorDom = exports; }` });
    await page.evaluate((nesting) => {
      const dom = (window as unknown as AnchorDomWindow).anchorDom;
      const root = document.querySelector("article")!;
      dom.renderAnnotationMarks(root, [{
        id: "own-mark", contentType: "book", contentId: "book", sectionId: "chapter:1",
        contentTitle: "测试书", contentUrl: "/book/test", authorId: "reader", authorName: "读者",
        quote: "中国人", prefix: "前文", suffix: "后文", startOffset: 2, endOffset: 5,
        createdAt: "2026-09-13T00:00:00Z", comments: [], underlinedByMe: true, underlineCount: 1,
      }], () => {});
      if (nesting === "underline contains search") {
        const location = root.querySelector("[data-test-location]")!;
        location.replaceWith(...location.childNodes);
        for (const underline of root.querySelectorAll("[data-content-annotation]")) {
          const marker = document.createElement("mark");
          marker.dataset.bookSearchTarget = "true";
          marker.dataset.testLocation = "";
          marker.append(...underline.childNodes);
          underline.append(marker);
        }
      }
    }, nesting);

    // This is the pink background and straight red line that used to survive
    // saving/deleting an underline after navigating from the notes list.
    for (const marker of await page.locator("[data-test-location]").all()) {
      expect(await marker.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
      expect(await marker.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
    }
    await page.evaluate(() => {
      (window as unknown as AnchorDomWindow).anchorDom.clearTextAnchorMarks(document.querySelector("article")!, "mark[data-book-search-target]", {
        quote: "中国人", prefix: "前文", suffix: "后文", startOffset: 2, endOffset: 5,
      });
    });
    await expect(page.locator("[data-test-location]")).toHaveCount(0);
    await expect(page.locator("[data-content-annotation]")).toHaveCount(2);
    for (const underline of await page.locator("[data-content-annotation]").all()) {
      await expect(underline).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(underline).toHaveCSS("box-shadow", "none");
      await expect(underline).toHaveCSS("text-decoration-style", "wavy");
      await expect(underline).toHaveCSS("text-decoration-line", "underline");
    }
    await page.evaluate(() => {
      (window as unknown as AnchorDomWindow).anchorDom.renderAnnotationMarks(document.querySelector("article")!, [], () => {});
    });
    await expect(page.locator("[data-content-annotation]")).toHaveCount(0);
    await expect(page.locator("#source-anchor")).toHaveText("人");
    await expect(page.locator("#source-anchor")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(page.locator("#source-anchor")).toHaveCSS("box-shadow", "none");
    await expect(page.locator("#source-anchor")).toHaveCSS("text-decoration-line", "none");
    await expect(page.locator("#other-result[data-book-search-target]")).toHaveText("别处");
    await expect(page.locator("[data-reader-explanation]")).toHaveText("解释");
    await page.getByRole("link", { name: "原注" }).click();
    await expect(page).toHaveURL(/#footnote$/);
  });
}
