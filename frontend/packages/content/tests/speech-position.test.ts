import { describe, expect, it } from "vitest";
import { speechFromReadingPosition, speechSegmentOffsets } from "../src/speech-position";

describe("listening entry position", () => {
  it("starts after the first sentence ending following the visible character, preserving later cache segments", () => {
    const segments = ["第一章", "前一页的句子。正在看的句子。后面的句子。", "再下一段。"];
    const text = segments.join("");
    const entry = speechFromReadingPosition(segments, { text, offset: text.indexOf("在看") });
    expect(entry.segments[entry.index]).toBe("后面的句子。");
    expect(entry.segments.at(-1)).toBe(segments.at(-1));
    expect(entry.segments.join("")).toBe(text);
    expect(segments).toHaveLength(3);
  });
  it("keeps a full sentence already at the start of the visible page", () => {
    const segments = ["标题", "他说：“第一句。”第二句。第三句。"];
    const text = segments.join("");
    const entry = speechFromReadingPosition(segments, { text, offset: text.indexOf("第二句") });
    expect(entry.segments[entry.index]).toBe("第二句。第三句。");
  });
  it("matches repeated passages in document order and tolerates an absent displayed title", () => {
    const segments = ["书名", "重复。", "重复。", "最后。"];
    expect(speechSegmentOffsets("重复。重复。最后。", segments)).toEqual([-1, 0, 3, 6]);
    expect(speechFromReadingPosition(segments, { text: "重复。重复。最后。", offset: 4 }).index).toBe(3);
  });
  it("splits the raw text without losing English word spaces", () => {
    const segments = ["A first sentence. A second sentence. The final sentence."];
    const text = segments.join("").replace(/\s/g, "");
    const entry = speechFromReadingPosition(segments, { text, offset: 3 });
    expect(entry.segments[entry.index]).toBe("A second sentence. The final sentence.");
  });
  it("does not rewind the entire last chunk when the visible sentence ends the chapter", () => {
    const segments = ["前面已经读过。最后一句正在阅读。"];
    const text = segments[0]!;
    const entry = speechFromReadingPosition(segments, { text, offset: text.indexOf("正在") });
    expect(entry.segments[entry.index]).toBe("最后一句正在阅读。");
  });
});
