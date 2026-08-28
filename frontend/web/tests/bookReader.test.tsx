import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookReader } from "../src/rag/components/BookReader";
import { useFeatureFlagStore } from "../src/featureFlags";
import { useAccountSessionStore } from "../src/account/session";

const annotationApi = vi.hoisted(() => ({
  loadAnnotationThreads: vi.fn(async () => []),
  createAnnotation: vi.fn(),
  addAnnotationComment: vi.fn(),
  reportAnnotationComment: vi.fn(),
}));
const readerDataApi = vi.hoisted(() => ({
  bookshelfContains: vi.fn(async () => false),
  popularExplanations: vi.fn(async () => []),
  reusableExplanation: vi.fn(async () => undefined),
  saveExplanation: vi.fn(async () => undefined),
  setBookshelf: vi.fn(async () => undefined),
}));
const ragApi = vi.hoisted(() => ({
  askStream: vi.fn((
    _params: unknown,
    _onChunk: (text: string) => void,
    _onDone: (references?: unknown[], conversationId?: string, metadata?: unknown) => void,
    _onError: (message: string) => void,
    _onActivity?: (activity: unknown) => void,
  ) => vi.fn()),
}));

vi.mock("../src/annotations/api", () => annotationApi);
vi.mock("../src/rag/readerData", () => readerDataApi);
vi.mock("../src/rag/api", () => ragApi);

class ResizeObserverMock {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

describe("BookReader", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useFeatureFlagStore.setState({
      initialized: true,
      revision: "reader-test",
      flags: {
        "library.bookshelf": true,
        "reader.annotations": true,
      },
    });
    useAccountSessionStore.setState({ initialized: true, userId: "11111111-1111-4111-8111-111111111111", displayName: "测试读者-ABC" });
    annotationApi.loadAnnotationThreads.mockResolvedValue([]);
    annotationApi.createAnnotation.mockReset();
    annotationApi.addAnnotationComment.mockReset();
    annotationApi.reportAnnotationComment.mockReset();
    readerDataApi.reusableExplanation.mockResolvedValue(undefined);
    readerDataApi.saveExplanation.mockResolvedValue(undefined);
    readerDataApi.popularExplanations.mockResolvedValue([]);
    ragApi.askStream.mockClear();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200, writable: true });
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 240, right: 420, top: 220, bottom: 250, width: 180, height: 30, x: 240, y: 220, toJSON: () => ({}) }),
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function renderReader(
    onChapterChange = vi.fn(),
    onInternalLink = vi.fn(),
    focus?: { anchorId?: string; text?: string },
    strict = false,
  ) {
    const reader = (
      <MemoryRouter>
        <BookReader
          bookTitle="测试书"
          datasetId="test-books"
          itemId="test-books:full-book"
          manifestObject="content/books/test-books/items/full-book/manifest.jox"
          characterCount={12000}
          logicalChapterCount={40}
          chapters={[{ id: "chapter-1", title: "第一章" }, { id: "chapter-2", title: "第二章" }]}
          toc={[
            { id: "toc-1", targetId: "chapter-1", title: "第一章", depth: 0 },
            { id: "toc-2", targetId: "chapter-2", title: "第二章", depth: 0 },
          ]}
          activeChapterId="chapter-1"
          chapterKey="chapter-1"
          focusAnchorId={focus?.anchorId}
          focusText={focus?.text ? { text: focus.text, token: 1 } : undefined}
          backHref="/rag/chat"
          onChapterChange={onChapterChange}
          onLocate={vi.fn()}
          onInternalLink={onInternalLink}
          onSearch={vi.fn(async () => [])}
        >
          <h1>第一章</h1>
          <p id="citation-target">这是正文。</p>
          <p><a href="#annotation-test">[1]</a></p>
          <p id="annotation-test">这是注释。</p>
          <img src="blob:test-image" alt="测试插图" />
        </BookReader>
      </MemoryRouter>
    );
    const view = render(strict ? <StrictMode>{reader}</StrictMode> : reader);
    return { ...view, onChapterChange, onInternalLink };
  }

  it("uses a real two-column paged layout on desktop by default", () => {
    const { container } = renderReader();
    const flow = container.querySelector<HTMLElement>("[data-book-page-flow]");
    const toolbar = container.querySelector<HTMLElement>("[data-book-toolbar]");
    const bookshelfButton = screen.getByRole("button", { name: "加入书架" });
    expect(flow).not.toBeNull();
    expect(flow?.style.columnCount).toBe("2");
    expect(toolbar?.className).toContain("right-5");
    expect(toolbar?.className).not.toContain("left-5");
    expect(toolbar?.contains(bookshelfButton)).toBe(false);
    expect(bookshelfButton.closest("header")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /账号菜单/ })).toBeNull();
    expect(screen.queryByText("测试读者-ABC")).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "切换阅读模式" }).dataset.readerMode).toBe("paged");
    expect(screen.queryByRole("button", { name: "阅读设置" })).toBeNull();
    expect(screen.getByRole("button", { name: "调整字号" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "选择纸张颜色" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "切换纸张纹理" })).toBeTruthy();
    expect(screen.queryByText("上一节")).toBeNull();
    expect(screen.queryByText(/按 ← →/)).toBeNull();
  });

  it("switches to scrolling mode and remembers the choice", async () => {
    renderReader();
    fireEvent.click(screen.getByRole("button", { name: "切换阅读模式" }));
    expect(screen.queryByText(/\/ 1 页/)).toBeNull();
    await waitFor(() => expect(window.localStorage.getItem("jojo-reader-mode")).toBe("scroll"));
  });

  it("uses a plain mode label and a minimal font-size slider", () => {
    renderReader();
    expect(screen.getByRole("button", { name: "切换阅读模式" }).textContent).toContain("双页");
    fireEvent.click(screen.getByRole("button", { name: "调整字号" }));
    expect(screen.getByRole("slider", { name: "字号" }).className).toContain("book-reader-range");
  });

  it("stores paper color and texture independently", async () => {
    renderReader();
    fireEvent.click(screen.getByRole("button", { name: "选择纸张颜色" }));
    fireEvent.click(screen.getByRole("button", { name: "夜间" }));
    fireEvent.click(screen.getByRole("button", { name: "切换纸张纹理" }));
    await waitFor(() => {
      expect(window.localStorage.getItem("jojo-reader-paper-color")).toBe("dark");
      expect(window.localStorage.getItem("jojo-reader-paper-texture")).toBe("false");
    });
  });

  it("jumps to footnotes instantly and marks the destination", () => {
    renderReader();
    fireEvent.click(screen.getByRole("button", { name: "切换阅读模式" }));
    fireEvent.click(screen.getByRole("link", { name: "[1]" }));
    const target = screen.getByText("这是注释。");
    expect(target.getAttribute("data-book-jump-target")).toBe("true");
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "center" });
  });

  it("keeps a stable citation anchor focused when its quote cannot be matched", async () => {
    vi.useFakeTimers();
    window.localStorage.setItem("jojo-reader-mode", "scroll");
    renderReader(vi.fn(), vi.fn(), {
      anchorId: "citation-target",
      text: "这段摘录已被截断，无法逐字匹配",
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(200); });

    const target = document.getElementById("citation-target");
    expect(target?.getAttribute("data-book-jump-target")).toBe("true");
    expect(document.activeElement).toBe(target);
  });

  it("routes imported cross-chapter links through stable chapter and anchor ids", () => {
    const onInternalLink = vi.fn();
    const { container } = renderReader(vi.fn(), onInternalLink);
    const link = document.createElement("a");
    link.href = "#section-2";
    link.dataset.targetId = "chapter-2";
    link.dataset.anchorId = "section-2";
    link.textContent = "第二章";
    container.querySelector("[data-book-page-flow]")?.append(link);
    fireEvent.click(link);
    expect(onInternalLink).toHaveBeenCalledWith("chapter-2", "section-2");
  });

  it("turns into the next chapter with the right arrow at the final spread", () => {
    const onChapterChange = vi.fn();
    renderReader(onChapterChange);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onChapterChange).toHaveBeenCalledWith("chapter-2");
  });

  it("keeps a visible next-page button instead of hiding it at the page edge", () => {
    const onChapterChange = vi.fn();
    renderReader(onChapterChange);
    const next = screen.getByRole<HTMLButtonElement>("button", { name: "下一页" });
    expect(next.className).not.toContain("opacity-0");
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    expect(onChapterChange).toHaveBeenCalledWith("chapter-2");
  });

  it("uses a brief content fade without delaying the next page", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    const onChapterChange = vi.fn();
    const { container } = renderReader(onChapterChange);
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(onChapterChange).toHaveBeenCalledWith("chapter-2");
    expect(container.querySelector(".book-page-content-arrive")).not.toBeNull();
    expect(container.querySelector(".book-page-turn-stage")).toBeNull();
    act(() => vi.advanceTimersByTime(160));
    expect(container.querySelector(".book-page-content-arrive")).toBeNull();
    vi.useRealTimers();
  });

  it("selects chapters from the reusable table of contents drawer", () => {
    const onChapterChange = vi.fn();
    renderReader(onChapterChange);
    fireEvent.click(screen.getByRole("button", { name: "打开目录" }));
    expect(screen.getByText(/40 章/)).toBeTruthy();
    const drawer = document.querySelector("aside");
    expect(drawer?.className).toContain("right-0");
    expect(drawer?.className).not.toContain("left-0");
    const search = screen.getByRole("textbox", { name: "搜索目录" });
    expect(search.className).toContain("book-toc-search");
    expect(search.closest("label")?.className).toContain("border-b");
    fireEvent.click(screen.getByRole("button", { name: "第二章" }));
    expect(onChapterChange).toHaveBeenCalledWith("chapter-2");
  });

  it("pads an odd number of physical pages so the final spread does not repeat a column", async () => {
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const scrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() { return this.hasAttribute("data-book-page-flow") ? 1000 : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get() {
        if (!this.hasAttribute("data-book-page-flow")) return 0;
        return this.querySelector("[data-book-trailing-page]") ? 2080 : 1540;
      },
    });

    try {
      const { container } = renderReader();
      await waitFor(() => expect(container.querySelector("[data-book-trailing-page]")).not.toBeNull());
    } finally {
      if (clientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
      else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
      if (scrollWidth) Object.defineProperty(HTMLElement.prototype, "scrollWidth", scrollWidth);
      else delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
    }
  });

  it("opens book images in a dismissible full-screen preview", () => {
    renderReader();
    fireEvent.click(screen.getByRole("img", { name: "测试插图" }));
    expect(screen.getByRole("dialog", { name: "图片预览" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭图片预览" }));
    expect(screen.queryByRole("dialog", { name: "图片预览" })).toBeNull();
  });

  it("shows contextual actions for selected text and copies without leaving the reader", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { container } = renderReader();
    const paragraph = screen.getByText("这是正文。");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.pointerUp(container.querySelector("[data-book-page-flow]")!);

    const toolbar = await screen.findByRole("toolbar", { name: "选中文字工具" });
    expect(toolbar.textContent).toContain("复制");
    expect(toolbar.textContent).toContain("划线");
    expect(toolbar.textContent).toContain("写想法");
    expect(screen.getByRole("button", { name: "AI 解释" }).textContent).toContain("Beta");
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("这是正文。"));
    expect(screen.queryByRole("toolbar", { name: "选中文字工具" })).toBeNull();
  });

  it("persists a selected passage and initial comment through the shared annotation API", async () => {
    annotationApi.createAnnotation.mockResolvedValue({
      id: "annotation-1",
      contentType: "book",
      contentId: "test-books:test-books:full-book",
      sectionId: "chapter-1",
      contentTitle: "测试书 · 第一章",
      contentUrl: "/book/test-books/test-books:full-book",
      authorId: "11111111-1111-4111-8111-111111111111",
      authorName: "测试读者-ABC",
      quote: "这是正文。",
      prefix: "第一章",
      suffix: "[1]这是注释。",
      startOffset: 3,
      endOffset: 8,
      createdAt: "2026-08-18T10:00:00Z",
      comments: [],
    });
    const { container } = renderReader();
    const paragraph = screen.getByText("这是正文。");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.pointerUp(container.querySelector("[data-book-page-flow]")!);

    fireEvent.click(await screen.findByRole("button", { name: "写想法" }));
    fireEvent.change(screen.getByPlaceholderText("写下此刻的想法……"), { target: { value: "值得继续讨论" } });
    expect(screen.getByRole("radio", { name: "公开" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(annotationApi.createAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: "book", sectionId: "chapter-1" }),
      expect.objectContaining({ quote: "这是正文。" }),
      "值得继续讨论",
      "public",
    ));
    expect(await screen.findByRole("complementary", { name: "划线详情" })).toBeTruthy();
  });

  it("saves a plain underline without opening the discussion panel", async () => {
    annotationApi.createAnnotation.mockResolvedValue({
      id: "annotation-underline-1",
      contentType: "book",
      contentId: "test-books:test-books:full-book",
      sectionId: "chapter-1",
      contentTitle: "测试书 · 第一章",
      contentUrl: "/book/test-books/test-books:full-book",
      authorId: "11111111-1111-4111-8111-111111111111",
      authorName: "测试读者-ABC",
      quote: "这是正文。",
      prefix: "第一章",
      suffix: "[1]这是注释。",
      startOffset: 3,
      endOffset: 8,
      createdAt: "2026-08-18T10:00:00Z",
      comments: [],
    });
    const { container } = renderReader();
    const paragraph = screen.getByText("这是正文。");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.pointerUp(container.querySelector("[data-book-page-flow]")!);

    fireEvent.click(await screen.findByRole("button", { name: "划线" }));

    await waitFor(() => expect(annotationApi.createAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: "book", sectionId: "chapter-1" }),
      expect.objectContaining({ quote: "这是正文。" }),
      undefined,
      "public",
    ));
    expect(screen.queryByRole("complementary", { name: "划线详情" })).toBeNull();
    expect(screen.getByText("已划线")).toBeTruthy();
  });

  it("keeps AI available while hiding bookshelf and annotation writes when their flags are off", async () => {
    useFeatureFlagStore.setState((state) => ({
      ...state,
      flags: { ...state.flags, "library.bookshelf": false, "reader.annotations": false },
    }));
    const { container } = renderReader();
    expect(screen.queryByRole("button", { name: "加入书架" })).toBeNull();
    expect(screen.getByRole("button", { name: "打开书内 AI" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "打开书内 AI" }));
    expect(screen.getByRole("note", { name: "AI 实验功能说明" }).textContent).toContain("回答可能不准确、遗漏或误解原文");
    fireEvent.click(screen.getAllByRole("button", { name: "关闭书内 AI" })[0]!);

    const paragraph = screen.getByText("这是正文。");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.pointerUp(container.querySelector("[data-book-page-flow]")!);

    const toolbar = await screen.findByRole("toolbar", { name: "选中文字工具" });
    expect(toolbar.textContent).toContain("复制");
    expect(screen.getByRole("button", { name: "AI 解释" }).textContent).toContain("Beta");
    fireEvent.click(screen.getByRole("button", { name: "AI 解释" }));

    await waitFor(() => expect(ragApi.askStream).toHaveBeenCalledWith(
      expect.objectContaining({
        datasetIds: ["test-books"],
        itemIds: ["test-books:full-book"],
        manifestObjects: ["content/books/test-books/items/full-book/manifest.jox"],
        scopeMode: "selected",
        focus: expect.objectContaining({
          chapterId: "chapter-1",
          chapterTitle: "第一章",
          quote: "这是正文。",
          prefix: expect.any(String),
          suffix: expect.any(String),
        }),
      }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    ));
  });

  it("opens the AI panel before checking the shared explanation cache", async () => {
    let finishCacheLookup: ((value: undefined) => void) | undefined;
    readerDataApi.reusableExplanation.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      finishCacheLookup = resolve;
    }));
    const { container } = renderReader();
    const paragraph = screen.getByText("这是正文。");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.pointerUp(container.querySelector("[data-book-page-flow]")!);

    fireEvent.click(await screen.findByRole("button", { name: "AI 解释" }));

    expect(screen.getByRole("complementary", { name: "书内 AI" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("正在查找已有解释");
    expect(ragApi.askStream).not.toHaveBeenCalled();

    await act(async () => finishCacheLookup?.(undefined));
    await waitFor(() => expect(ragApi.askStream).toHaveBeenCalledTimes(1));
  });

  it("does not cancel the selection-driven AI request during the StrictMode effect check", async () => {
    const cancelStream = vi.fn();
    ragApi.askStream.mockReturnValueOnce(cancelStream);
    const { container } = renderReader(vi.fn(), vi.fn(), undefined, true);
    const paragraph = screen.getByText("这是正文。");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.pointerUp(container.querySelector("[data-book-page-flow]")!);

    fireEvent.click(await screen.findByRole("button", { name: "AI 解释" }));

    await waitFor(() => expect(ragApi.askStream).toHaveBeenCalledTimes(1));
    expect(cancelStream).not.toHaveBeenCalled();
  });

  it("stores only the first selection explanation in the shared cache", async () => {
    readerDataApi.saveExplanation.mockClear();
    const { container } = renderReader();
    const paragraph = screen.getByText("这是正文。");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.pointerUp(container.querySelector("[data-book-page-flow]")!);
    fireEvent.click(await screen.findByRole("button", { name: "AI 解释" }));

    await waitFor(() => expect(ragApi.askStream).toHaveBeenCalledTimes(1));
    const firstCall = ragApi.askStream.mock.calls[0]!;
    const reference = {
      citationId: "Jfocus",
      datasetId: "test-books",
      itemId: "test-books:full-book",
      targetId: "chapter-1",
    };
    act(() => {
      (firstCall[1] as (chunk: string) => void)("首次解释[cite:Jfocus]");
      (firstCall[2] as (references: typeof reference[], conversationId: string, metadata: { provider: string; model: string }) => void)(
        [reference],
        "conv-1",
        { provider: "openai-codex", model: "gpt-test" },
      );
    });
    await waitFor(() => expect(readerDataApi.saveExplanation).toHaveBeenCalledWith(expect.objectContaining({
      chapterId: "chapter-1",
      quote: "这是正文。",
      answer: "首次解释[cite:Jfocus]",
      references: [reference],
      metadata: { provider: "openai-codex", model: "gpt-test" },
    })));

    fireEvent.change(screen.getByRole("textbox", { name: "向本书提问" }), { target: { value: "继续追问" } });
    fireEvent.click(screen.getByRole("button", { name: "提问 →" }));
    await waitFor(() => expect(ragApi.askStream).toHaveBeenCalledTimes(2));
    const followUpCall = ragApi.askStream.mock.calls[1]!;
    act(() => {
      (followUpCall[1] as (chunk: string) => void)("追问答案");
      (followUpCall[2] as (references: unknown[], conversationId: string) => void)([], "conv-1");
    });

    expect(readerDataApi.saveExplanation).toHaveBeenCalledTimes(1);
  });

  it("does not load or expose shared comments to a signed-out reader", async () => {
    useAccountSessionStore.setState({ initialized: true, userId: null, displayName: null });
    annotationApi.loadAnnotationThreads.mockClear();
    renderReader();
    expect(screen.queryByRole("button", { name: "打开书内 AI" })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "划线详情" })).toBeNull();
    expect(annotationApi.loadAnnotationThreads).not.toHaveBeenCalled();
  });
});
