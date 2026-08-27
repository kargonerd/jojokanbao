import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearAnnotationMarks,
  clearReaderExplanationMarks,
  renderAnnotationMarks,
  renderReaderExplanationMarks,
  textAnchorFromRange,
} from "../src/annotations/domAnchors";
import type { AnnotationThread } from "../src/annotations/types";

afterEach(() => { document.body.innerHTML = ""; });

describe("shared annotation DOM anchors", () => {
  it("captures and restores a selection spanning multiple text elements", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>第一段文字</p><p>第二段文字</p>";
    document.body.append(root);
    const first = root.querySelectorAll("p")[0]!.firstChild!;
    const second = root.querySelectorAll("p")[1]!.firstChild!;
    const range = document.createRange();
    range.setStart(first, 2);
    range.setEnd(second, 3);
    const anchor = textAnchorFromRange(root, range)!;
    expect(anchor.quote).toBe("段文字第二段");

    const opened = vi.fn();
    const thread: AnnotationThread = {
      id: "annotation-1",
      contentType: "book",
      contentId: "book-1",
      sectionId: "chapter-1",
      contentTitle: "测试书",
      authorId: "user-1",
      authorName: "读者-ABC",
      createdAt: "2026-08-18T10:00:00Z",
      comments: [],
      ...anchor,
    };
    expect(renderAnnotationMarks(root, [thread], opened)).toBe(1);
    const marks = root.querySelectorAll("mark[data-content-annotation='annotation-1']");
    expect(Array.from(marks).map((mark) => mark.textContent).join("")).toBe(anchor.quote);
    (marks[0] as HTMLElement).click();
    expect(opened).toHaveBeenCalledWith("annotation-1");
    clearAnnotationMarks(root);
    expect(root.querySelector("mark")).toBeNull();
    expect(root.textContent).toBe("第一段文字第二段文字");
  });

  it("refuses to anchor selections outside the content root", () => {
    const root = document.createElement("div");
    const outside = document.createTextNode("外部文字");
    document.body.append(root, outside);
    const range = document.createRange();
    range.selectNodeContents(outside);
    expect(textAnchorFromRange(root, range)).toBeUndefined();
  });

  it("opens only the innermost thread when annotation ranges overlap", () => {
    const root = document.createElement("div");
    root.textContent = "一段可以重叠划线的正文";
    document.body.append(root);
    const base = {
      contentType: "book" as const,
      contentId: "book-1",
      sectionId: "chapter-1",
      contentTitle: "测试书",
      authorId: "user-1",
      authorName: "读者",
      createdAt: "2026-08-19T10:00:00Z",
      comments: [],
      prefix: "",
      suffix: "",
    };
    const opened = vi.fn();
    renderAnnotationMarks(root, [
      { ...base, id: "outer", quote: "一段可以重叠划线", startOffset: 0, endOffset: 8 },
      { ...base, id: "inner", quote: "可以重叠", startOffset: 2, endOffset: 6 },
    ], opened);

    root.querySelector<HTMLElement>("mark[data-content-annotation='inner']")!.click();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith("inner");
  });

  it("locates repeated Reader AI quotes by context without nesting marks", () => {
    const root = document.createElement("div");
    root.textContent = "甲前文同一句甲后文。乙前文同一句乙后文";
    document.body.append(root);
    const explanations = [
      { quote: "同一句", prefix: "甲前文", suffix: "甲后文", startOffset: null, endOffset: null, count: 2 },
      { quote: "同一句", prefix: "乙前文", suffix: "乙后文", startOffset: null, endOffset: null, count: 4 },
    ];
    const opened = vi.fn();

    expect(renderReaderExplanationMarks(root, explanations, opened)).toBe(2);
    expect(root.querySelectorAll("mark[data-reader-explanation]")).toHaveLength(2);
    expect(root.querySelector<HTMLElement>("mark[data-reader-explanation]")?.title).toBe("点击查看 AI 解释");
    expect(root.querySelector<HTMLElement>("mark[data-reader-explanation]")?.getAttribute("aria-label")).toBe("查看 AI 解释");
    root.querySelectorAll<HTMLElement>("mark[data-reader-explanation]")[1]!.click();
    expect(opened).toHaveBeenCalledWith(explanations[1]);

    expect(renderReaderExplanationMarks(root, explanations, opened)).toBe(2);
    expect(root.querySelectorAll("mark[data-reader-explanation]")).toHaveLength(2);
    clearReaderExplanationMarks(root);
    expect(root.querySelector("mark[data-reader-explanation]")).toBeNull();
  });
});
