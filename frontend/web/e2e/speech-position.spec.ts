import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import * as content from "@jojo/content";
import { SPEECH_READER_FACTORY } from "@jojo/content/speech-dom-script";
import { speechFromReadingPosition, speechSegments, SPEECH_EXCLUDED_ELEMENTS } from "@jojo/content";
// Compile the native CommonJS package at this boundary; the browser executes its actual injected script.
const continuousSource = ts.transpileModule(readFileSync(new URL("../../mobile/src/lib/continuousBookScroll.generated.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const nativeContinuous = {} as typeof import("../../mobile/src/lib/continuousBookScroll.generated");
new Function("exports", continuousSource)(nativeContinuous);
const annotationDomSource = ts.transpileModule(readFileSync(new URL("../../mobile/src/lib/annotationDomScript.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const nativeAnnotationDom = {} as typeof import("../../mobile/src/lib/annotationDomScript");
new Function("exports", annotationDomSource)(nativeAnnotationDom);
const nativeSource = ts.transpileModule(readFileSync(new URL("../../mobile/src/lib/bookReaderBridge.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const nativeBridge = {} as typeof import("../../mobile/src/lib/bookReaderBridge");
new Function("require", "exports", nativeSource)((id: string) => {
  if (id === "@jojo/content") return content;
  if (id === "@jojo/content/speech-dom-script") return { SPEECH_READER_FACTORY };
  if (id === "./continuousBookScroll.generated") return nativeContinuous;
  if (id === "./annotationDomScript") return nativeAnnotationDom;
  throw new Error(`Unsupported native bridge dependency: ${id}`);
}, nativeBridge);
const { createBookReaderBridgeScript, createBookReaderGoToSpreadScript, createBookReaderSpeechHighlightScript, createBookReaderSpeechPositionScript } = nativeBridge;
const documentSource = ts.transpileModule(readFileSync(new URL("../../mobile/src/lib/bookDocument.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const nativeDocument = {} as typeof import("../../mobile/src/lib/bookDocument");
new Function("exports", "require", documentSource)(nativeDocument,
  createRequire(new URL("../../mobile/src/lib/bookDocument.ts", import.meta.url)));
const { createBookDocument } = nativeDocument;

for (const mode of ["paged", "scroll"] as const) {
  test(`native annotation completion clears selection and temporary feedback in ${mode} mode`, async ({ page }) => {
    await page.setContent(createBookDocument({
      fragment: { formatVersion: "jojo-fragment/1", itemId: "test", fragmentId: "c1", type: "chapter", order: 1, title: "正文",
        body: { format: "html", value: '<p id="quote">已保存这段文字，保留想法。</p><p id="other">另一处搜索结果。</p><p id="footnote">脚注内容</p>' }, assetRefs: [], annotations: [] },
      assetUrls: {}, textScale: 1, lineHeight: 1.95, firstLineIndent: true, eInk: false, readingMode: mode, paperColor: "ivory",
    }));
    await page.addScriptTag({ content: createBookReaderBridgeScript("start") });
    const anchor = { chapterId: "c1", start: 0, end: 4, quote: "这段文字", prefix: "已保存", suffix: "，保留想法。" };
    await page.addScriptTag({ content: nativeBridge.createBookReaderApplyAnnotationScript({ id: "own", ...anchor }) });
    await page.addScriptTag({ content: nativeBridge.createBookReaderLocateTextScript(anchor.quote, "c1") });
    const paragraph = page.locator('[data-reader-anchor-id="quote"]');
    await expect(paragraph.locator("mark[data-search-target]")).toHaveCount(1);
    await page.evaluate(() => {
      const target = document.querySelector('mark[data-search-target]')!;
      const range = document.createRange(); range.selectNodeContents(target);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      document.querySelector('[data-reader-anchor-id="other"]')!.innerHTML = '<mark data-search-target="unrelated">另一处搜索结果。</mark>';
      document.querySelector('[data-reader-anchor-id="footnote"]')!.setAttribute("data-book-jump-target", "true");
    });
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(anchor.quote);

    await page.addScriptTag({ content: nativeBridge.createBookReaderClearSelectionScript(anchor) });

    expect(await page.evaluate(() => window.getSelection()?.rangeCount)).toBe(0);
    await expect(paragraph.locator("mark[data-search-target]")).toHaveCount(0);
    await expect(paragraph.locator("[data-book-jump-target]")).toHaveCount(0);
    await expect(paragraph.locator('mark[data-annotation-id="own"]')).toHaveCSS("text-decoration-style", "wavy");
    await expect(page.locator('mark[data-search-target="unrelated"]')).toHaveCount(1);
    await expect(page.locator('[data-reader-anchor-id="footnote"]')).toHaveAttribute("data-book-jump-target", "true");

    await page.addScriptTag({ content: nativeBridge.createBookReaderRemoveAnnotationScript("own") });

    await expect(paragraph.locator("mark")).toHaveCount(0);
    await expect(paragraph).toHaveText("已保存这段文字，保留想法。");
    await expect(paragraph).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(paragraph).toHaveCSS("text-decoration-line", "none");
  });
}

for (const mode of ["paged", "scroll"] as const) {
  test(`native inline bootstrap initializes and resolves speech after reinjection in ${mode} mode`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    const paragraphs = Array.from({ length: 55 }, (_, i) => `<p>第${i + 1}段。为什么会有不如意的事？事物的发展和变化都有一定的条件。这是一段检查手机章节加载与当前位置朗读的正文。</p>`).join("");
    const chapters = [{ id: "chapter-5" }, { id: "chapter-6" }, { id: "chapter-7" }];
    const html = createBookDocument({
      fragment: { formatVersion: "jojo-fragment/1", itemId: "大众哲学", fragmentId: "chapter-6", type: "chapter", order: 6,
        title: "六 为什么会有不如意的事——辩证唯物论", body: { format: "html", value: paragraphs }, assetRefs: [], annotations: [] },
      assetUrls: {}, textScale: 1.12, lineHeight: 1.95, firstLineIndent: true, eInk: false, readingMode: mode, paperColor: "ivory",
    });
    const bootstrap = `window.__jojoReaderSessionId = "native-session";\n${createBookReaderBridgeScript("start", false, [], undefined, undefined, undefined, {
      initialChapterId: "chapter-6", chapters,
    })}`;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const channel = '<script>window.readerMessages=[];window.ReactNativeWebView={postMessage:function(value){window.readerMessages.push(JSON.parse(value));}};</script>';
    await page.setContent(html.replace("<head>", `<head>${channel}`).replace("</body>", () => `<script>${bootstrap.replace(/<\/script/gi, "<\\/script")}</script></body>`));
    const messages = () => page.evaluate(() => (window as unknown as { readerMessages: Array<{ type: string; readerSessionId?: string; position?: { text: string; offset: number } }> }).readerMessages);
    await expect.poll(async () => (await messages()).filter((message) => message.type === "reader-ready").length).toBe(1);
    await expect.poll(async () => (await messages()).some((message) => message.type === "reader-page")).toBe(true);
    // onLoadEnd and the watchdog inject the same script again in native WebView.
    await page.addScriptTag({ content: bootstrap });
    if (mode === "paged") await page.addScriptTag({ content: createBookReaderGoToSpreadScript(3) });
    else await page.addScriptTag({ content: nativeBridge.createBookReaderGoToScrollProgressScript(.45, "chapter-6") });
    await page.addScriptTag({ content: createBookReaderSpeechPositionScript(99) });
    await expect.poll(async () => (await messages()).find((message) => message.type === "reader-speech-position")?.position?.offset ?? 0).toBeGreaterThan(200);
    expect((await messages()).every((message) => message.readerSessionId === "native-session")).toBe(true);
    expect(errors).toEqual([]);
    if (mode === "scroll") await expect(page.locator('[data-reader-chapter-slot="chapter-6"]')).toHaveCount(1);
  });
}

for (const viewport of [{ width: 390, height: 700 }, { width: 1200, height: 700 }]) {
  for (const textScale of [0.9, 1.12]) {
    test(`native page margins stay symmetric at ${viewport.width}px and ${textScale} text scale`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const paragraphs = Array.from({ length: 8 }, (_, i) => `<p id="column-${i}" style="height:calc(100vh - 144px);margin:0;">第${i + 1}页。${"这是检查翻页后左右留白的完整正文。".repeat(4)}</p>`).join("");
      await page.setContent(createBookDocument({
        fragment: { formatVersion: "jojo-fragment/1", itemId: "test", fragmentId: "c1", type: "chapter", order: 1, title: "封面",
          body: { format: "html", value: paragraphs }, assetRefs: [], annotations: [] },
        assetUrls: {}, textScale, lineHeight: 1.95, firstLineIndent: true, eInk: false, readingMode: "paged", paperColor: "white",
      }));
      await page.addScriptTag({ content: createBookReaderBridgeScript("start") });
      const columns = viewport.width >= 900 ? 2 : 1;
      const margin = columns === 2 ? 48 : 24;
      for (const spread of [0, 1, 8 / columns - 1]) {
        await page.addScriptTag({ content: createBookReaderGoToSpreadScript(spread) });
        for (let column = 0; column < columns; column++) {
          const rect = await page.locator(`[data-reader-anchor-id="column-${spread * columns + column}"]`).boundingBox();
          expect(rect!.x).toBeCloseTo(column * viewport.width / columns + margin, 1);
          expect(rect!.width).toBeCloseTo(viewport.width / columns - 2 * margin, 1);
          expect(rect!.y).toBeGreaterThanOrEqual(72);
        }
      }
      await expect(page.locator("article")).toHaveCSS("padding-top", "72px");
      await expect(page.locator("article")).toHaveCSS("padding-bottom", "72px");
      await expect(page.locator("#jojo-page-footer span").nth(columns - 1)).toHaveText("8 / 8");
    });
  }
}

for (const mode of ["paged", "scroll"] as const) {
  test(`listening reveals visible text without highlighting in actual ${mode} layout`, async ({ page }) => {
    const paragraphs = Array.from({ length: 80 }, (_, i) => `第${i + 1}段。这是一段用于检查阅读位置和听书高亮的正文。翻到后面几页之后，应该从当前页面的完整句子开始朗读。`);
    const segments = speechSegments("第一章", paragraphs.join("\n\n"), "text");
    await page.setContent(`<style>body{margin:0}#surface{margin:48px;width:400px;height:320px;overflow:hidden;font:20px/40px serif;${mode === "paged" ? "column-count:1;column-gap:48px;column-fill:auto" : "overflow-y:auto"}}p{margin:0 0 20px}</style><div id="surface"><div id="content" style="display:contents"><h1>第一章</h1>${paragraphs.map((text) => `<p>${text}</p>`).join("")}</div></div>`);
    await page.addScriptTag({ content: `window.makeSpeechReader = ${SPEECH_READER_FACTORY};` });
    const position = await page.evaluate(({ mode, excluded }) => {
      const surface = document.getElementById("surface")!;
      if (mode === "paged") surface.scrollLeft = 448 * 3;
      else surface.scrollTop = 900;
      const host = window as unknown as { makeSpeechReader: typeof import("@jojo/content/speech-dom").createSpeechReader; reader: ReturnType<typeof import("@jojo/content/speech-dom").createSpeechReader> };
      host.reader = host.makeSpeechReader(document.getElementById("content")!, () => surface.getBoundingClientRect(), excluded);
      return host.reader.read();
    }, { mode, excluded: SPEECH_EXCLUDED_ELEMENTS });
    expect(position.offset).toBeGreaterThan(100);
    const entry = speechFromReadingPosition(segments, position);
    expect(entry.index).toBeGreaterThan(0);
    const result = await page.evaluate(({ entry, mode }) => {
      const surface = document.getElementById("surface")!;
      const host = window as unknown as { reader: ReturnType<typeof import("@jojo/content/speech-dom").createSpeechReader> };
      const original = surface.textContent;
      surface.scrollLeft = 0;
      surface.scrollTop = 0;
      let revealed = "";
      host.reader.show(entry.segments, entry.index, (range) => {
        revealed = range.toString();
        const rect = range.getClientRects()[0]!;
        if (mode === "paged") surface.scrollLeft = Math.floor((rect.left - surface.getBoundingClientRect().left + surface.scrollLeft + 1) / 448) * 448;
        else surface.scrollTop += rect.top - surface.getBoundingClientRect().top;
      });
      return { highlights: document.querySelectorAll("[data-speech-highlight]").length, unchanged: original === surface.textContent, revealed, position: host.reader.read() };
    }, { entry, mode });
    expect(result.unchanged).toBe(true);
    expect(result.revealed.replace(/\s/gu, "")).toBe(entry.segments[entry.index]!.replace(/\s/gu, ""));
    expect(result.position.offset).toBeGreaterThan(100);
    expect(result.highlights).toBe(0);
  });
}

test("native book bridge returns to the spoken passage without highlighting", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  const paragraphs = Array.from({ length: 60 }, (_, i) => `第${i + 1}段。这是手机阅读器中的正文，用来验证翻页后的听书位置。暂停时可以自由翻页，再播放继续原来的音频。`);
  const segments = speechSegments("第一章", paragraphs.join("\n\n"), "text");
  await page.setContent(createBookDocument({
    fragment: { formatVersion: "jojo-fragment/1", itemId: "test", fragmentId: "c1", type: "chapter", order: 1, title: "第一章",
      body: { format: "html", value: paragraphs.map((text) => `<p>${text}</p>`).join("") }, assetRefs: [], annotations: [] },
    assetUrls: {}, textScale: 1.25, lineHeight: 2, firstLineIndent: true,
    eInk: false, readingMode: "paged", paperColor: "ivory",
  }));
  await expect(page.locator("article")).toHaveAttribute("data-reader-chapter-id", "c1");
  await page.addScriptTag({ content: "window.readerMessages=[];window.ReactNativeWebView={postMessage: function(value){window.readerMessages.push(JSON.parse(value));}};" });
  await page.addScriptTag({ content: createBookReaderBridgeScript("start") });
  await expect.poll(() => page.evaluate(() => (window as unknown as { readerMessages: Array<{ spreadCount?: number }> }).readerMessages.some((message) => (message.spreadCount ?? 0) > 3))).toBe(true);
  await page.addScriptTag({ content: createBookReaderGoToSpreadScript(3) });
  await page.addScriptTag({ content: createBookReaderSpeechPositionScript(1) });
  const position = await page.evaluate(() => (window as unknown as { readerMessages: Array<{ type: string; position: { text: string; offset: number } }> }).readerMessages.find((message) => message.type === "reader-speech-position")!.position);
  expect(position.offset).toBeGreaterThan(200);
  const entry = speechFromReadingPosition(segments, position);
  const location = { chapterId: "c1", segments: entry.segments, index: entry.index };
  await page.addScriptTag({ content: createBookReaderSpeechHighlightScript(location, true) });
  await expect(page.locator("[data-speech-highlight]")).toHaveCount(0);
  await page.addScriptTag({ content: createBookReaderGoToSpreadScript(0) });
  await page.addScriptTag({ content: createBookReaderSpeechPositionScript(2) });
  const readOffset = (requestId: number) => page.evaluate((id) => (window as unknown as { readerMessages: Array<{ requestId: number; position: { offset: number } }> }).readerMessages.find((message) => message.requestId === id)!.position.offset, requestId);
  expect(await readOffset(2)).toBe(0);
  await page.addScriptTag({ content: createBookReaderSpeechHighlightScript(location, true) });
  await page.addScriptTag({ content: createBookReaderSpeechPositionScript(3) });
  expect(await readOffset(3)).toBeGreaterThan(200);
  await expect(page.locator("[data-speech-highlight]")).toHaveCount(0);
});
