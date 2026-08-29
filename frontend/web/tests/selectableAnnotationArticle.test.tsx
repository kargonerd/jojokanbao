import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    fireEvent.click(screen.getByRole("button", { name: "保存想法" }));
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

    expect(await screen.findByRole("toolbar", { name: "选中文字工具" })).toBeTruthy();
  });
});
