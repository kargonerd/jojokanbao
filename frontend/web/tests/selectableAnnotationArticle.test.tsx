import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectableAnnotationArticle } from "../src/annotations/SelectableAnnotationArticle";
import { useFeatureFlagStore } from "../src/featureFlags";
import { useAccountSessionStore } from "../src/account/session";
import type { AnnotationThread } from "../src/annotations/types";

const annotationApi = vi.hoisted(() => ({
  loadAnnotationThreads: vi.fn<() => Promise<AnnotationThread[]>>(async () => []),
  createAnnotation: vi.fn(),
  addAnnotationComment: vi.fn(),
  reportAnnotationComment: vi.fn(),
  deleteMyAnnotationMark: vi.fn(),
  setAnnotationCommentLike: vi.fn(),
}));
vi.mock("../src/annotations/api", () => annotationApi);

describe("SelectableAnnotationArticle", () => {
  const ownThread: AnnotationThread = {
    id: "annotation-news-1", contentType: "newspaper", contentId: "news-1", sectionId: "body", contentTitle: "新闻标题",
    authorId: "another-reader", authorName: "先划线的人", quote: "报刊正文", prefix: "", suffix: "", startOffset: 0, endOffset: 4,
    createdAt: "2026-08-18T10:00:00Z", comments: [], underlineCount: 1, underlinedByMe: true, publiclyVisible: false,
  };

  it("deletes only my mark from its floating toolbar and removes the underline", async () => {
    annotationApi.loadAnnotationThreads.mockResolvedValue([ownThread]);
    annotationApi.deleteMyAnnotationMark.mockRejectedValueOnce(new Error("网络连接失败")).mockResolvedValueOnce(null);
    const { container } = render(<SelectableAnnotationArticle subject={ownThread}><p>报刊正文</p></SelectableAnnotationArticle>);
    const mark = await screen.findByRole("button", { name: "查看这处划线，1 人划线" });
    vi.spyOn(mark, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 150, 100, 20));
    fireEvent.click(mark);
    const toolbar = screen.getByRole("toolbar", { name: "划线工具" });
    expect(within(toolbar).getByRole("button", { name: "复制" })).toBeTruthy();
    fireEvent.click(within(toolbar).getByRole("button", { name: "删除划线" }));
    expect(await screen.findByText("网络连接失败")).toBeTruthy();
    expect(container.querySelector("mark[data-underlined-by-me]")).toBeTruthy();
    fireEvent.click(within(toolbar).getByRole("button", { name: "删除划线" }));
    await waitFor(() => expect(container.querySelector("mark")).toBeNull());
    expect(screen.getByText("报刊正文")).toBeTruthy();
    expect(annotationApi.deleteMyAnnotationMark).toHaveBeenLastCalledWith(ownThread.id, "user-1");
  });

  it("does not offer deletion for another reader's public underline", async () => {
    annotationApi.loadAnnotationThreads.mockResolvedValue([{ ...ownThread, authorId: "user-1", underlinedByMe: false, publiclyVisible: true }]);
    render(<SelectableAnnotationArticle subject={ownThread}><p>报刊正文</p></SelectableAnnotationArticle>);
    fireEvent.click(await screen.findByRole("button", { name: "查看这处划线，1 人划线" }));
    expect(screen.getByRole("complementary", { name: "划线详情" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "删除划线" })).toBeNull();
  });
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    useFeatureFlagStore.setState({ initialized: true, revision: "test", flags: { "reader.speech": false, "library.bookshelf": false, "reader.annotations": true } });
    useAccountSessionStore.setState({ initialized: true, userId: "user-1", displayName: "报刊读者-ABC" });
    annotationApi.loadAnnotationThreads.mockResolvedValue([]);
    annotationApi.createAnnotation.mockResolvedValue({
      id: "annotation-news-1", contentType: "newspaper", contentId: "news-1", sectionId: "body", contentTitle: "新闻标题",
      authorId: "user-1", authorName: "报刊读者-ABC", quote: "报刊正文", prefix: "", suffix: "", startOffset: 0, endOffset: 4,
      createdAt: "2026-08-18T10:00:00Z", comments: [],
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => ({ left: 100, right: 200, top: 150, bottom: 170, width: 100, height: 20 }) });
  });
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    cleanup();
    vi.unstubAllGlobals();
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
      "user-1",
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
    useFeatureFlagStore.setState({ initialized: true, revision: "test", flags: { "reader.speech": false, "library.bookshelf": false, "reader.annotations": false } });
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
