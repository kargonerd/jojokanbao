import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectableAnnotationArticle } from "../src/annotations/SelectableAnnotationArticle";
import { useFeatureFlagStore } from "../src/featureFlags";
import { useAccountSessionStore } from "../src/account/session";

const annotationApi = vi.hoisted(() => ({
  loadAnnotationThreads: vi.fn(async () => []),
  createAnnotation: vi.fn(),
  addAnnotationComment: vi.fn(),
  reportAnnotationComment: vi.fn(),
}));
vi.mock("../src/annotations/api", () => annotationApi);

describe("SelectableAnnotationArticle", () => {
  beforeEach(() => {
    useFeatureFlagStore.setState({ initialized: true, revision: "test", flags: { "library.bookshelf": false, "reader.annotations": true } });
    useAccountSessionStore.setState({ initialized: true, userId: "user-1", displayName: "报刊读者-ABC" });
    annotationApi.loadAnnotationThreads.mockResolvedValue([]);
    annotationApi.createAnnotation.mockResolvedValue({
      id: "annotation-news-1", contentType: "newspaper", contentId: "news-1", sectionId: "body", contentTitle: "新闻标题",
      authorId: "user-1", authorName: "报刊读者-ABC", quote: "报刊正文", prefix: "", suffix: "", startOffset: 0, endOffset: 4,
      createdAt: "2026-08-18T10:00:00Z", comments: [],
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => ({ left: 100, top: 100, bottom: 120, width: 100 }) });
  });
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    cleanup();
  });

  it("uses the same annotation contract for a newspaper body", async () => {
    render(<SelectableAnnotationArticle subject={{ contentType: "newspaper", contentId: "news-1", sectionId: "body", contentTitle: "新闻标题" }}><p>报刊正文</p></SelectableAnnotationArticle>);
    const paragraph = screen.getByText("报刊正文");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.pointerUp(paragraph, { pointerType: "touch" });
    fireEvent.click(await screen.findByRole("button", { name: "写想法" }));
    fireEvent.change(screen.getByPlaceholderText("写下此刻的想法……"), { target: { value: "报刊评论" } });
    expect(screen.getByRole("radio", { name: "公开" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(annotationApi.createAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: "newspaper", contentId: "news-1" }),
      expect.objectContaining({ quote: "报刊正文" }),
      "报刊评论",
      "public",
    ));
  });

  it("opens the selection tools after a keyboard selection", async () => {
    render(<SelectableAnnotationArticle subject={{ contentType: "newspaper", contentId: "news-1", sectionId: "body", contentTitle: "新闻标题" }}><p>键盘选择正文</p></SelectableAnnotationArticle>);
    const paragraph = screen.getByText("键盘选择正文");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    fireEvent.keyUp(paragraph, { key: "ArrowRight", shiftKey: true });

    const toolbar = await screen.findByRole("toolbar", { name: "选中文字工具" });
    expect(toolbar.textContent).toContain("复制");
    expect(within(toolbar).getAllByRole("button").every((button) => button.classList.contains("reader-selection-action"))).toBe(true);
  });

  it("copies selected text with the shared reader action", async () => {
    const originalClipboard = navigator.clipboard;
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      render(<SelectableAnnotationArticle subject={{ contentType: "newspaper", contentId: "news-1", sectionId: "body", contentTitle: "新闻标题" }}><p>复制这段报刊正文</p></SelectableAnnotationArticle>);
      const paragraph = screen.getByText("复制这段报刊正文");
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);

      fireEvent.pointerUp(paragraph);
      fireEvent.click(await screen.findByRole("button", { name: "复制" }));

      await waitFor(() => expect(writeText).toHaveBeenCalledWith("复制这段报刊正文"));
      expect(screen.queryByRole("toolbar", { name: "选中文字工具" })).toBeNull();
    } finally {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
    }
  });

  it("offers AI explanation independently from the annotation feature flag", async () => {
    useFeatureFlagStore.setState({ initialized: true, revision: "test", flags: { "library.bookshelf": false, "reader.annotations": false } });
    const onExplain = vi.fn();
    render(<SelectableAnnotationArticle subject={{ contentType: "newspaper", contentId: "news-1", sectionId: "body", contentTitle: "新闻标题" }} onExplain={onExplain}><p>图表中的红色曲线</p></SelectableAnnotationArticle>);
    const paragraph = screen.getByText("图表中的红色曲线");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    fireEvent.pointerUp(paragraph);
    fireEvent.click(await screen.findByRole("button", { name: "AI 解释" }));

    expect(onExplain).toHaveBeenCalledWith(expect.objectContaining({ quote: "图表中的红色曲线" }));
    expect(screen.queryByRole("button", { name: "复制" })).toBeNull();
    expect(screen.queryByRole("button", { name: "划线" })).toBeNull();
  });
});
