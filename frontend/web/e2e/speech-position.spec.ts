import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as content from "@jojo/content";
import { SPEECH_READER_FACTORY } from "@jojo/content/speech-dom-script";
import { speechFromReadingPosition, speechSegments, SPEECH_EXCLUDED_ELEMENTS } from "@jojo/content";
// Compile the native CommonJS package at this boundary; the browser executes its actual injected script.
const nativeSource = ts.transpileModule(readFileSync(new URL("../../mobile/src/lib/bookReaderBridge.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const nativeBridge = {} as typeof import("../../mobile/src/lib/bookReaderBridge");
new Function("require", "exports", nativeSource)((id: string) => id === "@jojo/content" ? content : { SPEECH_READER_FACTORY }, nativeBridge);
const { createBookReaderBridgeScript, createBookReaderGoToSpreadScript, createBookReaderSpeechHighlightScript, createBookReaderSpeechPositionScript } = nativeBridge;

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
  await page.setContent(`<style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}article{width:100vw;height:100vh;padding:80px 32px;column-count:1;column-fill:auto;column-gap:64px;overflow:visible;font:20px/40px serif;transform:translate3d(0,0,0)}p{margin:0 0 20px}</style><body data-reading-mode="paged"><article><h1>第一章</h1><div data-book-content data-target-id="c1">${paragraphs.map((text) => `<p>${text}</p>`).join("")}</div></article></body>`);
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
