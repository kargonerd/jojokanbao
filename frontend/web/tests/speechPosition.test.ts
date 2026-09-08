import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpeechReader, SPEECH_EXCLUDED_ELEMENTS } from "@jojo/content/speech-dom";
import { SPEECH_READER_FACTORY } from "@jojo/content/speech-dom-script";
import { speechFromReadingPosition } from "@jojo/content";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe.each(["web", "native WebView"])("%s speech text mapping", (platform) => {
  it("captures the first visible character and highlights the actual repeated passage without changing annotation offsets", async () => {
    const root = document.createElement("article");
    root.innerHTML = '<h1>标题</h1><p>旧页。<sup>1</sup></p><p><b>重复。</b>重复。最后。</p><figure>略过</figure>';
    document.body.appendChild(root);
    const factory: typeof createSpeechReader = platform === "web" ? createSpeechReader : new Function(`return ${SPEECH_READER_FACTORY}`)();
    const rect = (left: number, top: number) => new DOMRect(left, top, 24, 24);
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: function (this: Range) {
      const value = this.startContainer.textContent ?? "";
      return [rect(0, value === "标题" || value === "旧页。" || this.startContainer.parentElement?.tagName === "B" ? -100 : 10)];
    } });
    const reader = factory(root, () => ({ left: 0, top: 0, right: 300, bottom: 300 }), SPEECH_EXCLUDED_ELEMENTS);
    const position = reader.read();
    expect(position).toEqual({ text: "标题旧页。重复。重复。最后。", offset: 8 });
    const original = root.innerHTML;
    const entry = speechFromReadingPosition(["标题", "旧页。", "重复。", "重复。", "最后。"], position);
    const reveal = vi.fn();
    reader.show(entry.segments, entry.index, reveal);
    const range = reveal.mock.calls[0]![0] as Range;
    expect(range.toString()).toBe("重复。");
    expect(range.startContainer.parentElement?.tagName).toBe("P");
    expect(root.innerHTML).toBe(original);
    expect(document.querySelector("[data-speech-highlight] span")).not.toBeNull();
    reveal.mockClear();
    reader.show(["标题", "旧页。", "重复。重复。最后。"], 2, reveal, { start: 3, end: 6 });
    const sentenceRange = reveal.mock.calls[0]![0] as Range;
    expect(sentenceRange.toString()).toBe("重复。");
    expect(sentenceRange.startContainer.parentElement?.tagName).toBe("P");
    root.innerHTML = original.replace("重复。最后。", '<mark data-annotation-id="new">重复。</mark>最后。');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(document.querySelector("[data-speech-highlight] span")).not.toBeNull();
    expect(root.querySelector("mark")?.textContent).toBe("重复。");
    reader.clear();
    expect(document.querySelector("[data-speech-highlight]")).toBeNull();
    reader.destroy();
  });
});
