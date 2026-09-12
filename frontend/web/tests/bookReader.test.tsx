import { StrictMode, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookReader } from "../src/rag/components/BookReader";
import { SpeechPlayer } from "../src/reading/SpeechPlayer";
import { useFeatureFlagStore } from "../src/featureFlags";
import { useAccountSessionStore } from "../src/account/session";
import { useRecentReadingStore } from "../src/library/recentReadingStore";

const annotationApi = vi.hoisted(() => ({
  loadAnnotationThreads: vi.fn(async () => []),
  loadMyBookAnnotations: vi.fn(async () => []),
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

function LocationProbe() {
  const location = useLocation();
  return <span hidden data-testid="reader-location">{`${location.pathname}${location.search}${location.hash}`}</span>;
}

describe("BookReader", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useRecentReadingStore.setState({ items: [] });
    useFeatureFlagStore.setState({
      initialized: true,
      revision: "reader-test",
      flags: {
        "reader.speech": true,
        "library.bookshelf": true,
        "reader.annotations": true,
      },
    });
    useAccountSessionStore.setState({ initialized: true, userId: "11111111-1111-4111-8111-111111111111", displayName: "测试读者-ABC" });
    annotationApi.loadAnnotationThreads.mockResolvedValue([]);
    annotationApi.loadMyBookAnnotations.mockResolvedValue([]);
    annotationApi.createAnnotation.mockReset();
    annotationApi.addAnnotationComment.mockReset();
    annotationApi.reportAnnotationComment.mockReset();
    readerDataApi.reusableExplanation.mockResolvedValue(undefined);
    readerDataApi.saveExplanation.mockResolvedValue(undefined);
    readerDataApi.popularExplanations.mockResolvedValue([]);
    ragApi.askStream.mockClear();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200, writable: true });
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal("PointerEvent", MouseEvent);
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 240, right: 420, top: 220, bottom: 250, width: 180, height: 30, x: 240, y: 220, toJSON: () => ({}) }),
    });
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function renderReader(
    onChapterChange = vi.fn(),
    onInternalLink = vi.fn(),
    focus?: { anchorId?: string; text?: string },
    strict = false,
    activeChapterId = "chapter-1",
  ) {
    const reader = (
      <MemoryRouter initialEntries={["/book/test-books/test-books:full-book"]}>
        <BookReader
          bookTitle="测试书"
          datasetId="test-books"
          itemId="test-books:full-book"
          itemKey="full-book"
          manifestObject="content/books/test-books/items/full-book/manifest.jox"
          characterCount={12000}
          logicalChapterCount={40}
          chapters={[{ id: "chapter-1", title: "第一章" }, { id: "chapter-2", title: "第二章" }]}
          toc={[
            { id: "toc-1", targetId: "chapter-1", title: "第一章", depth: 0 },
            { id: "toc-1-section", targetId: "chapter-1", anchorId: "citation-target", title: "小节 · 正文", depth: 1 },
            { id: "toc-2", targetId: "chapter-2", title: "第二章", depth: 0 },
          ]}
          activeChapterId={activeChapterId}
          chapterKey={activeChapterId}
          focusAnchorId={focus?.anchorId}
          focusText={focus?.text ? { text: focus.text, token: 1 } : undefined}
          backHref="/rag/chat"
          onChapterChange={onChapterChange}
          onLocate={vi.fn()}
          onInternalLink={onInternalLink}
          onSearch={vi.fn(async () => [])}
          onDownload={vi.fn()}
          speechControl={<SpeechPlayer label="听本章" segments={["这是正文。"]} />}
        >
          <h1>第一章</h1>
          <p id="citation-target">这是正文。</p>
          <p><a href="#annotation-test">[1]</a></p>
          <p id="annotation-test">这是注释。</p>
          <img src="blob:test-image" alt="测试插图" />
        </BookReader>
        <LocationProbe />
      </MemoryRouter>
    );
    const view = render(strict ? <StrictMode>{reader}</StrictMode> : reader);
    return { ...view, onChapterChange, onInternalLink };
  }

  async function renderContinuousReader() {
    window.localStorage.setItem("jojo-reader-mode", "scroll");
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const scroll = document.querySelector<HTMLElement>("[data-book-reading-surface]");
      const section = this.matches("[data-book-chapter-id]") ? this : this.closest("[data-book-chapter-id]");
      const sections = Array.from(document.querySelectorAll("[data-book-chapter-id]"));
      const index = section ? sections.indexOf(section) : -1;
      const top = index < 0 ? 0 : index * 1000 - (scroll?.scrollTop ?? 0);
      const height = this === scroll ? 200 : index < 0 ? sections.length * 1000 : 1000;
      return { x: 0, y: top, top, bottom: top + height, left: 0, right: 600, width: 600, height, toJSON() {} };
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.hasAttribute("data-book-chapter-id") ? 1000 : 200; });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => document.querySelectorAll("[data-book-chapter-id]").length * 1000);
    const chapters = [{ id: "chapter-1", title: "第一章" }, { id: "chapter-2", title: "第二章" }];
    const loadChapter = vi.fn(async (id: string) => <>
      <h1>{id === "chapter-1" ? "第一章" : "第二章"}</h1>
      <p>{id} 连续正文。</p>
      <a href="#repeated-note">[1]</a>
      <p id="repeated-note">{id} 的脚注</p>
    </>);
    const onChapterChange = vi.fn();
    const onVisibleChapterChange = vi.fn();
    function Harness() {
      const [activeChapterId, setActiveChapterId] = useState("chapter-1");
      return <MemoryRouter><BookReader bookTitle="测试书" datasetId="test-books" itemId="test-books:full-book"
        itemKey="full-book" manifestObject="test-books/manifest.jox" characterCount={2000}
        chapters={chapters} toc={[]} activeChapterId={activeChapterId} chapterKey={activeChapterId}
        backHref="/library" onChapterChange={onChapterChange} onLocate={vi.fn()} onSearch={async () => []}
        loadChapter={loadChapter} onVisibleChapterChange={(id) => { onVisibleChapterChange(id); setActiveChapterId(id); }}
      ><p>初始占位</p></BookReader></MemoryRouter>;
    }
    const view = render(<Harness />);
    await screen.findByText("chapter-1 连续正文。");
    const scroll = view.container.querySelector<HTMLElement>("[data-book-reading-surface]")!;
    act(() => { scroll.scrollTop = 650; fireEvent.scroll(scroll); });
    await screen.findByText("chapter-2 连续正文。");
    return { ...view, scroll, loadChapter, onChapterChange, onVisibleChapterChange };
  }

  it("keeps desktop listening open until explicitly collapsed and retains the mini player", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ defaultProvider: "auto", providers: [
      { id: "auto", label: "朗读", available: true, voices: [{ id: "male", label: "男声" }] },
    ] })));
    renderReader();
    fireEvent.click(screen.getByRole("button", { name: "打开听本章播放器" }));
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(screen.getByRole("dialog", { name: "听本章播放器" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "收起听读播放器" }));
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(screen.getByRole("region", { name: "迷你听读播放器" })).toBeTruthy();
    fireEvent.click(screen.getByText("这是正文。", { selector: "p" }), { clientX: 600, detail: 1 });
    expect(screen.getByRole("region", { name: "迷你听读播放器" })).toBeTruthy();
  });

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
    expect(screen.queryByRole("button", { name: "阅读设置" })).toBeNull();
    expect(screen.getByRole("button", { name: "文字设置" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "调整字号" })).toBeNull();
    expect(screen.queryByRole("button", { name: "选择纸张颜色" })).toBeNull();
    expect(screen.queryByRole("button", { name: "切换纸张纹理" })).toBeNull();
    expect(screen.queryByText("上一节")).toBeNull();
    expect(screen.queryByText(/按 ← →/)).toBeNull();
  });

  it("records the current chapter and actual book progress for continuing later", async () => {
    renderReader(vi.fn(), vi.fn(), undefined, false, "chapter-2");

    await waitFor(() => expect(useRecentReadingStore.getState().items[0]).toMatchObject({
      id: "book:test-books:full-book",
      datasetId: "test-books",
      itemKey: "full-book",
      title: "测试书",
      subtitle: "第二章",
      href: "/book/test-books/full-book?chapter=chapter-2",
    }));
    expect(useRecentReadingStore.getState().items[0]?.progress).toBeGreaterThanOrEqual(50);
  });

  it("switches to scrolling mode and remembers the choice", async () => {
    renderReader();
    fireEvent.click(screen.getByRole("button", { name: "文字设置" }));
    fireEvent.click(screen.getByRole("button", { name: "滚动" }));
    expect(screen.queryByText(/\/ 1 页/)).toBeNull();
    await waitFor(() => expect(window.localStorage.getItem("jojo-reader-mode")).toBe("scroll"));
  });

  it("groups mode choices and the font-size slider in the desktop text panel", () => {
    renderReader();
    fireEvent.click(screen.getByRole("button", { name: "文字设置" }));
    expect(screen.getByRole("button", { name: "翻页" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "滚动" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "字号" }).className).toContain("book-reader-range");
  });

  it("groups the mobile reader into five primary tools with search inside the directory", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390, writable: true });
    const { container } = renderReader();
    const toolbar = container.querySelector<HTMLElement>("[data-reader-mobile-toolbar]");

    expect(toolbar).not.toBeNull();
    expect(within(toolbar!).getAllByRole("button")).toHaveLength(5);
    expect(within(toolbar!).getByRole("button", { name: "打开目录" })).toBeTruthy();
    expect(within(toolbar!).queryByRole("button", { name: "搜索全书" })).toBeNull();
    fireEvent.click(within(toolbar!).getByRole("button", { name: "打开目录" }));
    fireEvent.click(screen.getByRole("tab", { name: "⌕ 搜本书" }));
    expect(screen.getByRole("textbox", { name: "搜索全书正文" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "目录" }));
    expect(screen.getByRole("complementary", { name: "目录面板" })).toBeTruthy();
    expect(within(toolbar!).getByRole("button", { name: "打开书内 AI" })).toBeTruthy();
    expect(within(toolbar!).getByRole("button", { name: "阅读进度" })).toBeTruthy();
    expect(within(toolbar!).getByRole("button", { name: "阅读笔记" })).toBeTruthy();
    expect(within(toolbar!).getByRole("button", { name: "文字设置" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "切换纸张纹理" })).toBeNull();
  });

  it.each([390, 767, 768, 1200])("shares five tools and keeps listening floating on mobile and in the desktop toolbar at %spx", (width) => {
    window.innerWidth = width;
    renderReader();
    const toolbar = screen.getByRole("navigation", { name: "阅读工具" });
    expect(within(toolbar).getAllByRole("button").slice(0, 5).map((button) => button.getAttribute("aria-label"))).toEqual([
      "打开目录", "打开书内 AI", "阅读进度", "阅读笔记", "文字设置",
    ]);
    expect(within(toolbar).getAllByRole("button")).toHaveLength(width < 768 ? 5 : 7);
    const listeningButton = screen.getByRole("button", { name: "打开听本章播放器" });
    expect(toolbar.contains(listeningButton)).toBe(width >= 768);
    expect(Boolean(screen.queryByRole("button", { name: "下载整本 EPUB" }))).toBe(width >= 768);
    expect(within(document.querySelector("header")!).queryByText(/全书|%/)).toBeNull();
    fireEvent.click(within(toolbar).getByRole("button", { name: "打开目录" }));
    fireEvent.click(screen.getByRole("tab", { name: "⌕ 搜本书" }));
    expect(screen.getByRole("textbox", { name: "搜索全书正文" })).toBeTruthy();
  });

  it("keeps the listening player mounted when moving between mobile and desktop widths", () => {
    window.innerWidth = 390;
    useAccountSessionStore.setState({ userId: null });
    renderReader();
    fireEvent.click(screen.getByRole("button", { name: "打开听本章播放器" }));
    const dialog = screen.getByRole("dialog", { name: "登录后听读" });

    for (const width of [1200, 390]) {
      window.innerWidth = width;
      fireEvent.resize(window);
      expect(screen.getByRole("dialog", { name: "登录后听读" })).toBe(dialog);
      const launcher = screen.getByRole("button", { name: "打开听本章播放器" });
      expect(screen.getByRole("navigation", { name: "阅读工具" }).contains(launcher)).toBe(width >= 768);
    }
    fireEvent.click(screen.getByRole("button", { name: "暂不登录" }));
    expect(screen.queryByRole("dialog", { name: "登录后听读" })).toBeNull();
    expect(screen.getByRole("button", { name: "打开听本章播放器" })).toBeTruthy();
  });

  it.each([390, 1200])("respects the listening feature flag at %spx", (width) => {
    window.innerWidth = width;
    useFeatureFlagStore.setState({ flags: { ...useFeatureFlagStore.getState().flags, "reader.speech": false } });
    renderReader();
    expect(screen.queryByRole("button", { name: "打开听本章播放器" })).toBeNull();
  });

  it.each([390, 1200])("keeps tool panels draggable only on mobile at %spx", (width) => {
    window.innerWidth = width;
    renderReader();
    for (const [tool, label] of [
      ["打开目录", "目录面板"], ["打开书内 AI", "AI面板"], ["阅读进度", "阅读进度面板"],
      ["阅读笔记", "阅读笔记面板"], ["文字设置", "文字设置面板"],
    ]) {
      fireEvent.click(screen.getByRole("button", { name: tool }));
      const sheet = screen.getByRole("complementary", { name: label });
      const handle = within(sheet).queryByRole("button", { name: "调整书内导航高度" });
      if (width < 768) {
        expect(handle).not.toBeNull();
        fireEvent.pointerDown(handle!, { clientY: 200 });
        fireEvent.pointerMove(handle!, { clientY: 300 });
        fireEvent.pointerUp(handle!, { clientY: 300 });
      } else {
        expect(handle).toBeNull();
        fireEvent.click(within(sheet).getByRole("button", { name: /^关闭/ }));
      }
      expect(screen.queryByRole("complementary", { name: label })).toBeNull();
    }
  });

  it("keeps book search usable as the keyboard opens, pans, and closes", async () => {
    window.innerWidth = 390;
    vi.stubGlobal("innerHeight", 844);
    const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
    vi.stubGlobal("visualViewport", viewport);
    renderReader();
    fireEvent.click(screen.getByRole("button", { name: "打开目录" }));
    fireEvent.click(screen.getByRole("tab", { name: "⌕ 搜本书" }));
    const input = screen.getByRole<HTMLInputElement>("textbox", { name: "搜索全书正文" });
    expect(document.activeElement).not.toBe(input);
    input.focus();
    fireEvent.change(input, { target: { value: "正文" } });
    expect(document.activeElement).toBe(input);

    const sheet = screen.getByRole("complementary", { name: "全书搜索" });
    const frame = sheet.parentElement!;
    act(() => { viewport.height = 380; viewport.offsetTop = 48; viewport.dispatchEvent(new Event("resize")); });
    expect(frame.style.height).toBe("380px");
    expect(frame.style.top).toBe("48px");
    act(() => { viewport.offsetTop = 80; viewport.dispatchEvent(new Event("scroll")); });
    expect(frame.style.top).toBe("80px");
    expect(input.value).toBe("正文");

    fireEvent.submit(input.closest("form")!);
    expect(document.activeElement).not.toBe(input);
    expect(await screen.findByText("本书没有找到“正文”。")).toBeTruthy();
    act(() => { viewport.height = 844; viewport.offsetTop = 0; viewport.dispatchEvent(new Event("resize")); });
    expect(frame.style.height).toBe("844px");
    expect(frame.style.top).toBe("0px");
    expect(screen.getByRole("textbox", { name: "搜索全书正文" })).toBe(input);
    expect(input.value).toBe("正文");
    fireEvent.click(screen.getByRole("button", { name: "关闭书内导航" }));
    expect(screen.queryByRole("complementary", { name: "全书搜索" })).toBeNull();
  });

  it("resizes book navigation without VisualViewport and removes its listeners on close", () => {
    window.innerWidth = 390;
    vi.stubGlobal("innerHeight", 844);
    vi.stubGlobal("visualViewport", undefined);
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    renderReader();
    fireEvent.click(screen.getByRole("button", { name: "打开目录" }));
    const frame = screen.getByRole("complementary", { name: "目录面板" }).parentElement!;
    expect(frame.style.height).toBe("844px");
    vi.stubGlobal("innerHeight", 380);
    fireEvent(window, new Event("resize"));
    expect(frame.style.height).toBe("380px");
    expect(frame.style.top).toBe("0px");
    fireEvent.click(screen.getByRole("button", { name: "关闭书内导航" }));
    expect(removeEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
  });

  it.each(["scroll", "paged"])("toggles mobile tools but keeps the title visible in %s mode without remounting the text", (mode) => {
    window.innerWidth = 390;
    window.localStorage.setItem("jojo-reader-mode", mode);
    const { container } = renderReader();
    const paragraph = screen.getByText("这是正文。");
    const surface = container.querySelector("[data-book-reading-surface]");
    expect(screen.getByRole("navigation", { name: "阅读工具" })).toBeTruthy();

    fireEvent.click(paragraph, { clientX: 195, detail: 1 });
    expect(screen.queryByRole("navigation", { name: "阅读工具" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "阅读工具" })).toBeNull();
    expect(screen.getByRole("link", { name: "返回上一页" })).toBeTruthy();
    expect(within(container.querySelector("header")!).getByText("测试书")).toBeTruthy();
    expect(container.querySelector("header")?.hasAttribute("data-reader-chrome")).toBe(false);
    expect(container.querySelector("[data-reader-mobile-toolbar]")?.hasAttribute("inert")).toBe(true);
    expect(container.querySelector("[data-book-reading-surface]")).toBe(surface);
    expect(screen.getByText("这是正文。")).toBe(paragraph);
    if (mode === "paged") expect(screen.queryByRole("button", { name: "下一页" })).toBeNull();

    fireEvent.click(paragraph, { clientX: 195, detail: 1 });
    expect(screen.getByRole("navigation", { name: "阅读工具" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "阅读工具" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "返回上一页" })).toBeTruthy();
    expect(container.querySelector("[data-reader-mobile-toolbar]")?.hasAttribute("inert")).toBe(false);
  });

  it.each(["text", "margin"])("turns mobile pages by tapping the %s edges without page buttons", (target) => {
    window.innerWidth = 390;
    window.localStorage.setItem("jojo-reader-mode", "paged");
    const onChapterChange = vi.fn();
    const { container } = renderReader(onChapterChange);
    const surface = target === "text" ? screen.getByText("这是正文。") : container.querySelector("article")!;
    expect(screen.queryByRole("button", { name: "上一页", hidden: true })).toBeNull();
    expect(screen.queryByRole("button", { name: "下一页", hidden: true })).toBeNull();
    fireEvent.click(surface, { clientX: 20, detail: 1 });
    expect(onChapterChange).not.toHaveBeenCalled();
    fireEvent.click(surface, { clientX: 370, detail: 1 });
    expect(onChapterChange).toHaveBeenCalledWith("chapter-2");
    expect(screen.getByRole("navigation", { name: "阅读工具" })).toBeTruthy();
  });

  it("turns to the previous chapter with a left-edge tap", () => {
    window.innerWidth = 390;
    window.localStorage.setItem("jojo-reader-mode", "paged");
    const onChapterChange = vi.fn();
    renderReader(onChapterChange, vi.fn(), undefined, false, "chapter-2");
    fireEvent.click(screen.getByText("这是正文。"), { clientX: 20, detail: 1 });
    expect(onChapterChange).toHaveBeenCalledWith("chapter-1");
  });

  it("toggles tools instead of turning chapters on a scroll-mode edge tap", () => {
    window.innerWidth = 390;
    window.localStorage.setItem("jojo-reader-mode", "scroll");
    const onChapterChange = vi.fn();
    renderReader(onChapterChange);
    fireEvent.click(screen.getByText("这是正文。"), { clientX: 370, detail: 1 });
    expect(onChapterChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("navigation", { name: "阅读工具" })).toBeNull();
  });

  it.each(["move", "cancel", "scroll", "longpress"])("does not confuse a mobile %s gesture with a reader tap", (gesture) => {
    window.innerWidth = 390;
    const { container } = renderReader();
    const paragraph = screen.getByText("这是正文。");
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    fireEvent.pointerDown(paragraph, { clientX: 120, clientY: 160 });
    if (gesture === "move") fireEvent.pointerMove(paragraph, { clientX: 121, clientY: 210 });
    if (gesture === "cancel") fireEvent.pointerCancel(paragraph);
    if (gesture === "scroll") fireEvent.scroll(container.querySelector("[data-book-reading-surface]")!);
    if (gesture === "longpress") clock.mockReturnValue(1700);
    fireEvent.pointerUp(paragraph);
    fireEvent.click(paragraph);
    expect(screen.getByRole("navigation", { name: "阅读工具" })).toBeTruthy();

    fireEvent.pointerDown(paragraph, { clientX: 195, clientY: 160 });
    fireEvent.pointerUp(paragraph);
    fireEvent.click(paragraph);
    expect(screen.queryByRole("navigation", { name: "阅读工具" })).toBeNull();
  });

  it("does not hide mobile chrome when selecting text or dismissing a selection", () => {
    window.innerWidth = 390;
    renderReader();
    const paragraph = screen.getByText("这是正文。");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    fireEvent.click(paragraph);
    expect(screen.getByRole("navigation", { name: "阅读工具" })).toBeTruthy();
    fireEvent.pointerDown(paragraph);
    window.getSelection()?.removeAllRanges();
    fireEvent(document, new Event("selectionchange"));
    fireEvent.pointerUp(paragraph);
    fireEvent.click(paragraph);
    expect(screen.getByRole("navigation", { name: "阅读工具" })).toBeTruthy();
  });

  it("preserves mobile links and image actions and restores chrome on desktop resize", () => {
    window.innerWidth = 390;
    renderReader();
    fireEvent.click(screen.getByRole("link", { name: "[1]" }));
    expect(screen.getByRole("navigation", { name: "阅读工具" })).toBeTruthy();
    fireEvent.click(screen.getByRole("img", { name: "测试插图" }));
    expect(screen.getByRole("dialog", { name: "图片预览" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭图片预览" }));
    fireEvent.click(screen.getByText("这是正文。"));
    expect(screen.queryByRole("navigation", { name: "阅读工具" })).toBeNull();
    window.innerWidth = 1200;
    fireEvent(window, new Event("resize"));
    expect(screen.getByRole("navigation", { name: "阅读工具" })).toBeTruthy();
    fireEvent.click(screen.getByText("这是正文。"));
    expect(screen.getByRole("navigation", { name: "阅读工具" })).toBeTruthy();
  });

  it.each([390, 1200])("applies paper, texture, and mode and dismisses settings after each choice at %spx", async (width) => {
    window.innerWidth = width;
    window.localStorage.setItem("jojo-reader-mode", "scroll");
    renderReader();

    fireEvent.click(screen.getByRole("button", { name: "文字设置" }));
    expect(screen.getByRole("complementary", { name: "文字设置面板" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "字号" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "夜间" }));
    expect(screen.queryByRole("complementary", { name: "文字设置面板" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "文字设置" }));
    fireEvent.click(screen.getByRole("button", { name: "纸张纹理" }));
    expect(screen.queryByRole("complementary", { name: "文字设置面板" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "文字设置" }));
    fireEvent.click(screen.getByRole("button", { name: "翻页" }));
    expect(screen.queryByRole("complementary", { name: "文字设置面板" })).toBeNull();

    await waitFor(() => {
      expect(window.localStorage.getItem("jojo-reader-paper-color")).toBe("dark");
      expect(window.localStorage.getItem("jojo-reader-paper-texture")).toBe("false");
      expect(window.localStorage.getItem("jojo-reader-mode")).toBe("paged");
    });
  });

  it.each([390, 1200])("previews font changes throughout a drag and dismisses settings only on release at %spx", (width) => {
    window.innerWidth = width;
    renderReader();
    fireEvent.click(screen.getByRole("button", { name: "文字设置" }));
    const slider = screen.getByRole<HTMLInputElement>("slider", { name: "字号" });
    fireEvent.pointerDown(slider, { clientX: 100 });
    fireEvent.change(slider, { target: { value: "20" } });
    expect(screen.getByRole("complementary", { name: "文字设置面板" })).toBeTruthy();
    expect(slider.value).toBe("20");
    fireEvent.pointerMove(slider, { clientX: 140 });
    fireEvent.change(slider, { target: { value: "22" } });
    expect(screen.getByRole("slider", { name: "字号" })).toBe(slider);
    fireEvent.pointerUp(slider, { clientX: 140 });
    expect(screen.queryByRole("complementary", { name: "文字设置面板" })).toBeNull();
    expect(window.localStorage.getItem("jojo-reader-font-size")).toBe("22");
    fireEvent.click(screen.getByRole("button", { name: "文字设置" }));
    expect(screen.getByRole<HTMLInputElement>("slider", { name: "字号" }).value).toBe("22");
  });

  it.each([390, 1200])("keeps font settings open until a keyboard adjustment completes at %spx", (width) => {
    window.innerWidth = width;
    renderReader();
    fireEvent.click(screen.getByRole("button", { name: "文字设置" }));
    const slider = screen.getByRole<HTMLInputElement>("slider", { name: "字号" });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    fireEvent.change(slider, { target: { value: "21" } });
    expect(screen.getByRole("complementary", { name: "文字设置面板" })).toBeTruthy();
    fireEvent.keyUp(slider, { key: "Shift" });
    expect(screen.getByRole("slider", { name: "字号" })).toBe(slider);
    fireEvent.keyUp(slider, { key: "ArrowRight" });
    expect(screen.queryByRole("complementary", { name: "文字设置面板" })).toBeNull();
    expect(window.localStorage.getItem("jojo-reader-font-size")).toBe("21");
  });

  it.each([390, 1200])("shows book-wide progress and previews another chapter until the slider is released at %spx", async (width) => {
    window.innerWidth = width;
    const { onChapterChange } = renderReader();
    fireEvent.click(screen.getByRole("button", { name: "阅读进度" }));
    const sheet = screen.getByRole("complementary", { name: "阅读进度面板" });
    const slider = within(sheet).getByRole<HTMLInputElement>("slider", { name: "全书进度" });
    expect(within(sheet).getByText("阅读时长")).toBeTruthy();
    expect(within(sheet).getByText(/后读完|已读完/)).toBeTruthy();
    await waitFor(() => expect(within(sheet).getByRole("button", { name: /0\s*条\s*笔记/ })).toBeTruthy());
    expect(within(sheet).queryByText("—", { exact: true })).toBeNull();
    expect(sheet.textContent).not.toMatch(/本设备|每分钟\s*500|500\s*字/);
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: "75" } });
    expect(slider.getAttribute("aria-valuetext")).toContain("75.0%，第二章");
    expect(within(sheet).getByText("第二章")).toBeTruthy();
    expect(onChapterChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    expect(onChapterChange).toHaveBeenCalledExactlyOnceWith("chapter-2");
    expect(screen.getByRole("complementary", { name: "阅读进度面板" })).toBe(sheet);
  });

  it("leaves scroll-mode edge gestures to the continuous document without changing chapters", () => {
    window.localStorage.setItem("jojo-reader-mode", "scroll");
    const { container, onChapterChange } = renderReader();
    const scroll = container.querySelector<HTMLElement>("[data-book-reading-surface]")!;
    Object.defineProperties(scroll, { scrollHeight: { value: 1000 }, clientHeight: { value: 400 } });
    scroll.scrollTop = 600;
    fireEvent.scroll(scroll);
    fireEvent.wheel(scroll, { deltaY: 120 });
    fireEvent.touchStart(scroll, { touches: [{ clientX: 200, clientY: 500 }] });
    fireEvent.touchEnd(scroll, { changedTouches: [{ clientX: 200, clientY: 200 }] });
    expect(onChapterChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /下一章|上一章/ })).toBeNull();
  });

  it("keeps continuous chapter DOM and scroll position through visible chapter updates", async () => {
    const { scroll, onChapterChange, onVisibleChapterChange, loadChapter } = await renderContinuousReader();
    const first = screen.getByText("chapter-1 连续正文。");
    const second = screen.getByText("chapter-2 连续正文。");
    act(() => { scroll.scrollTop = 1125; fireEvent.scroll(scroll); });
    await waitFor(() => expect(onVisibleChapterChange).toHaveBeenLastCalledWith("chapter-2"));
    expect(scroll.scrollTop).toBe(1125);
    expect(screen.getByText("chapter-1 连续正文。")).toBe(first);
    expect(screen.getByText("chapter-2 连续正文。")).toBe(second);
    act(() => { scroll.scrollTop = 125; fireEvent.scroll(scroll); });
    await waitFor(() => expect(onVisibleChapterChange).toHaveBeenLastCalledWith("chapter-1"));
    expect(scroll.scrollTop).toBe(125);
    expect(loadChapter).toHaveBeenCalledTimes(2);
    expect(onChapterChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /下一章|上一章/ })).toBeNull();
  });

  it("resolves repeated footnote ids within the chapter containing the clicked link", async () => {
    const { container } = await renderContinuousReader();
    const first = container.querySelector<HTMLElement>('[data-book-chapter-id="chapter-1"]')!;
    const second = container.querySelector<HTMLElement>('[data-book-chapter-id="chapter-2"]')!;
    fireEvent.click(within(second).getByRole("link", { name: "[1]" }));
    const target = within(second).getByText("chapter-2 的脚注");
    expect(target.getAttribute("data-book-jump-target")).toBe("true");
    expect(within(first).getByText("chapter-1 的脚注").hasAttribute("data-book-jump-target")).toBe(false);
    expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts.at(-1)).toBe(target);
  });

  it("saves a selection from a loaded neighboring chapter under that chapter", async () => {
    annotationApi.createAnnotation.mockImplementation(async (subject, anchor) => ({
      ...subject, ...anchor, id: "neighbor-note", authorId: "11111111-1111-4111-8111-111111111111",
      authorName: "测试读者", createdAt: "2026-09-12T00:00:00Z", comments: [],
    }));
    const { onVisibleChapterChange } = await renderContinuousReader();
    expect(onVisibleChapterChange).not.toHaveBeenCalledWith("chapter-2");
    const paragraph = screen.getByText("chapter-2 连续正文。");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    fireEvent.click(await screen.findByRole("button", { name: "写想法" }));
    fireEvent.change(screen.getByPlaceholderText("写下此刻的想法……"), { target: { value: "第二章想法" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(annotationApi.createAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({ sectionId: "chapter-2", contentTitle: "测试书 · 第二章" }),
      expect.objectContaining({ quote: "chapter-2 连续正文。", startOffset: 3 }), "第二章想法", "public", "11111111-1111-4111-8111-111111111111",
    ));
    expect((await screen.findByRole("complementary", { name: "划线详情" })).textContent).toContain("chapter-2 连续正文。");
  });

  it("shows a friendly notes failure and retries without exposing the backend SQL error", async () => {
    await act(async () => { renderReader(); });
    const rawError = 'SQLSTATE 42702: column reference "id" is ambiguous in SELECT private.annotation_threads.id';
    annotationApi.loadMyBookAnnotations.mockReset().mockRejectedValueOnce(new Error(rawError)).mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: "阅读笔记" }));
    const panel = screen.getByRole("complementary", { name: "阅读笔记面板" });
    const alert = await within(panel).findByRole("alert");
    expect(alert.textContent).toContain("笔记暂时无法读取，请重试。");
    expect(panel.textContent).not.toMatch(/SQLSTATE|42702|SELECT|private\.annotation_threads|ambiguous/);
    expect(within(panel).queryByText("还没有笔记。选中正文，可以划线或写下想法。")).toBeNull();
    expect(annotationApi.loadMyBookAnnotations).toHaveBeenCalledExactlyOnceWith(
      "test-books:test-books:full-book",
      ["chapter-1", "chapter-2"],
      "11111111-1111-4111-8111-111111111111",
      { signal: expect.any(AbortSignal), onProgress: expect.any(Function) },
    );
    fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
    expect(await within(panel).findByText("还没有笔记。选中正文，可以划线或写下想法。")).toBeTruthy();
    expect(within(panel).queryByRole("alert")).toBeNull();
    expect(annotationApi.loadMyBookAnnotations).toHaveBeenCalledTimes(2);
  });

  it("does not turn the background book with arrow keys while a tool sheet is open", () => {
    const { onChapterChange } = renderReader();
    fireEvent.click(screen.getByRole("button", { name: "打开目录" }));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onChapterChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "关闭书内导航" }));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onChapterChange).toHaveBeenCalledWith("chapter-2");
  });

  it("cancels a progress drag without changing chapters and commits keyboard navigation", () => {
    const { onChapterChange } = renderReader();
    fireEvent.click(screen.getByRole("button", { name: "阅读进度" }));
    const slider = screen.getByRole<HTMLInputElement>("slider", { name: "全书进度" });
    const original = slider.value;
    fireEvent.change(slider, { target: { value: "80" } });
    fireEvent.pointerCancel(slider);
    expect(slider.value).toBe(original);
    expect(onChapterChange).not.toHaveBeenCalled();
    fireEvent.change(slider, { target: { value: "100" } });
    fireEvent.keyUp(slider, { key: "End" });
    expect(onChapterChange).toHaveBeenCalledExactlyOnceWith("chapter-2");
  });

  it("stores paper color and texture independently", async () => {
    renderReader();
    fireEvent.click(screen.getByRole("button", { name: "文字设置" }));
    fireEvent.click(screen.getByRole("button", { name: "夜间" }));
    expect(screen.queryByRole("complementary", { name: "文字设置面板" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "文字设置" }));
    fireEvent.click(screen.getByRole("button", { name: "纸张纹理" }));
    await waitFor(() => {
      expect(window.localStorage.getItem("jojo-reader-paper-color")).toBe("dark");
      expect(window.localStorage.getItem("jojo-reader-paper-texture")).toBe("false");
    });
  });

  it("jumps to footnotes instantly and marks the destination", () => {
    renderReader();
    fireEvent.click(screen.getByRole("button", { name: "文字设置" }));
    fireEvent.click(screen.getByRole("button", { name: "滚动" }));
    expect(screen.queryByRole("complementary", { name: "文字设置面板" })).toBeNull();
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

  it("turns immediately on a page-button click without animating the content", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    const onChapterChange = vi.fn();
    const { container } = renderReader(onChapterChange);
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(onChapterChange).toHaveBeenCalledWith("chapter-2");
    expect(container.querySelector(".book-page-content-arrive")).toBeNull();
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
    expect(drawer?.className).toContain("book-navigation-sheet");
    const search = screen.getByRole("textbox", { name: "搜索目录" });
    expect(search.className).toContain("book-toc-search");
    expect(search.closest("label")?.className).toContain("book-toc-filter");
    expect(screen.getByRole("button", { name: "小节 · 正文" }).closest("li")?.style.paddingLeft).toBe("20px");
    expect(within(drawer!).queryByText(/^(01|02)$/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "第二章" }));
    expect(onChapterChange).toHaveBeenCalledWith("chapter-2");
  });

  it("centers the current chapter when reopening the directory instead of starting at its first entry", async () => {
    renderReader(vi.fn(), vi.fn(), undefined, false, "chapter-2");
    fireEvent.click(screen.getByRole("button", { name: "打开目录" }));
    const current = screen.getByRole("button", { name: /第二章.*当前读到/ });
    expect(current.getAttribute("aria-current")).toBe("location");
    await waitFor(() => expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "center" }));
    expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts.at(-1)).toBe(current);
    fireEvent.click(screen.getByRole("button", { name: "关闭书内导航" }));
    vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "打开目录" }));
    await waitFor(() => expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "center" }));
    expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts.at(-1)).toBe(screen.getByRole("button", { name: /第二章.*当前读到/ }));
  });

  it.each([390, 1200])("keeps the current chapter when it is selected again at %ipx", (width) => {
    window.innerWidth = width;
    const { onChapterChange } = renderReader();

    fireEvent.click(screen.getByRole("button", { name: "打开目录" }));
    fireEvent.click(screen.getByRole("button", { name: /第一章/ }));

    expect(screen.queryByRole("complementary", { name: "目录面板" })).toBeNull();
    expect(onChapterChange).not.toHaveBeenCalled();
    expect(screen.getByText("这是正文。")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "打开目录" }));
    fireEvent.click(screen.getByRole("button", { name: "第二章" }));
    expect(onChapterChange).toHaveBeenCalledExactlyOnceWith("chapter-2");
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

  it.each([390, 1200])("dismisses image previews by tapping the image, backdrop or Escape at width %s", (width) => {
    window.innerWidth = width;
    // Both mobile web and the shared desktop reader use this preview.
    renderReader();
    fireEvent.click(screen.getByRole("img", { name: "测试插图" }));
    const preview = screen.getByRole("dialog", { name: "图片预览" });
    expect(within(preview).queryByText("关闭")).toBeNull();
    fireEvent.click(within(preview).getByRole("img", { name: "测试插图" }));
    expect(screen.queryByRole("dialog", { name: "图片预览" })).toBeNull();
    fireEvent.click(screen.getByRole("img", { name: "测试插图" }));
    fireEvent.click(screen.getByRole("dialog", { name: "图片预览" }));
    expect(screen.queryByRole("dialog", { name: "图片预览" })).toBeNull();
    fireEvent.click(screen.getByRole("img", { name: "测试插图" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "图片预览" })).toBeNull();
  });

  it.each([390, 1200])("keeps an explicit bookshelf label at width %s", (width) => {
    window.innerWidth = width;
    renderReader();
    const label = within(screen.getByRole("button", { name: "加入书架" })).getByText("加入书架");
    expect(label.className).not.toContain("hidden");
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
    fireEvent(document, new Event("selectionchange"));

    const toolbar = await screen.findByRole("toolbar", { name: "选中文字工具" });
    expect(toolbar.textContent).toContain("复制");
    expect(toolbar.textContent).toContain("划线");
    expect(toolbar.textContent).toContain("写想法");
    expect(within(toolbar).getAllByRole("button").every((button) => button.classList.contains("reader-selection-action"))).toBe(true);
    expect(screen.getByRole("button", { name: "AI 解释" }).querySelector("svg")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("这是正文。"));
    expect(screen.queryByRole("toolbar", { name: "选中文字工具" })).toBeNull();
  });

  it("suppresses the reader context menu and removes actions when selection collapses", () => {
    renderReader();
    const paragraph = screen.getByText("这是正文。");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    expect(fireEvent.contextMenu(paragraph)).toBe(false);
    expect(screen.getByRole("toolbar", { name: "选中文字工具" })).toBeTruthy();
    window.getSelection()?.removeAllRanges();
    fireEvent(document, new Event("selectionchange"));
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
    expect(screen.queryByRole("toolbar", { name: "选中文字工具" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "写想法" }).querySelector("blockquote")?.textContent).toBe("这是正文。");
    expect(screen.queryByRole("button", { name: "打开听本章播放器" })).toBeNull();
    expect(window.getSelection()?.toString()).toBe("");
    fireEvent(document, new Event("selectionchange"));
    fireEvent.change(screen.getByPlaceholderText("写下此刻的想法……"), { target: { value: "值得继续讨论" } });
    expect(screen.getByRole("radio", { name: "公开" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(annotationApi.createAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: "book", sectionId: "chapter-1" }),
      expect.objectContaining({ quote: "这是正文。" }),
      "值得继续讨论",
      "public",
      "11111111-1111-4111-8111-111111111111",
    ));
    expect(await screen.findByRole("complementary", { name: "划线详情" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "写想法" })).toBeNull();
  });

  it.each([390, 1200])("hides listening controls while reader panels are open at %ipx", (width) => {
    window.innerWidth = width;
    const { container } = renderReader();
    const launcher = screen.getByRole("button", { name: "打开听本章播放器" });
    fireEvent.click(screen.getByRole("button", { name: "打开书内 AI" }));
    expect(screen.queryByRole("button", { name: "打开听本章播放器" })).toBeNull();
    expect(container.querySelector(".speech-player")?.hasAttribute("inert")).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "关闭书内 AI" })[0]!);
    expect(screen.getByRole("button", { name: "打开听本章播放器" })).toBe(launcher);
    fireEvent.click(screen.getByRole("button", { name: "打开目录" }));
    expect(screen.queryByRole("button", { name: "打开听本章播放器" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "关闭书内导航" })[0]!);
    expect(screen.getByRole("button", { name: "打开听本章播放器" })).toBe(launcher);
  });

  it.each([390, 1200])("keeps the selected quote and draft independent of browser selection at %ipx", async (width) => {
    window.innerWidth = width;
    renderReader();
    const paragraph = screen.getByText("这是正文。");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    fireEvent.click(await screen.findByRole("button", { name: "写想法" }));
    const composer = screen.getByRole("dialog", { name: "写想法" });
    const input = within(composer).getByRole("textbox", { name: "想法内容" });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "不应该丢失的草稿" } });
    fireEvent(document, new Event("selectionchange"));
    fireEvent.scroll(document.querySelector("[data-book-reading-surface]")!);
    fireEvent.resize(window);
    expect(screen.queryByRole("toolbar", { name: "选中文字工具" })).toBeNull();
    expect(composer.querySelector("blockquote")?.textContent).toBe("这是正文。");
    expect((input as HTMLTextAreaElement).value).toBe("不应该丢失的草稿");
    fireEvent.click(within(composer).getByRole("button", { name: "取消写想法" }));
    expect(screen.queryByRole("dialog", { name: "写想法" })).toBeNull();
    expect(screen.queryByRole("toolbar", { name: "选中文字工具" })).toBeNull();
    expect(screen.getByRole("button", { name: "打开听本章播放器" })).toBeTruthy();
    expect(annotationApi.createAnnotation).not.toHaveBeenCalled();
  });

  it("keeps the thought draft and shows save errors inside the composer", async () => {
    annotationApi.createAnnotation.mockRejectedValueOnce(new Error("暂时无法保存"));
    renderReader();
    const range = document.createRange();
    range.selectNodeContents(screen.getByText("这是正文。"));
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    fireEvent.click(await screen.findByRole("button", { name: "写想法" }));
    fireEvent.change(screen.getByRole("textbox", { name: "想法内容" }), { target: { value: "只给自己看的想法" } });
    fireEvent.click(screen.getByRole("radio", { name: "仅自己可见" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect((await screen.findByRole("alert")).textContent).toBe("暂时无法保存");
    expect((screen.getByRole("textbox", { name: "想法内容" }) as HTMLTextAreaElement).value).toBe("只给自己看的想法");
    expect(annotationApi.createAnnotation).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ quote: "这是正文。" }), "只给自己看的想法", "private", "11111111-1111-4111-8111-111111111111");
    fireEvent(screen.getByRole("dialog", { name: "写想法" }), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog", { name: "写想法" })).toBeNull();
  });

  it("keeps the composer in the visible viewport when the mobile keyboard opens", async () => {
    window.innerWidth = 390;
    const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
    vi.stubGlobal("visualViewport", viewport);
    renderReader();
    const range = document.createRange();
    range.selectNodeContents(screen.getByText("这是正文。"));
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    fireEvent.click(await screen.findByRole("button", { name: "写想法" }));
    const composer = screen.getByRole("dialog", { name: "写想法" });
    act(() => { viewport.height = 380; viewport.offsetTop = 48; viewport.dispatchEvent(new Event("resize")); });
    expect(composer.style.height).toBe("380px");
    expect(composer.style.top).toBe("48px");
    expect(composer.querySelector("blockquote")?.textContent).toBe("这是正文。");
    expect(screen.queryByRole("toolbar", { name: "选中文字工具" })).toBeNull();
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
      "11111111-1111-4111-8111-111111111111",
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
    expect(screen.getByRole("button", { name: "AI 解释" }).querySelector("svg")).not.toBeNull();
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
    expect(screen.queryByRole("button", { name: "打开听本章播放器" })).toBeNull();
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

  it("keeps AI visible for a signed-out reader and sends them through login", async () => {
    useAccountSessionStore.setState({ initialized: true, userId: null, displayName: null });
    annotationApi.loadAnnotationThreads.mockClear();
    renderReader();
    fireEvent.click(screen.getByRole("button", { name: "打开书内 AI" }));
    expect(screen.getByTestId("reader-location").textContent).toBe("/account?returnTo=%2Fbook%2Ftest-books%2Ftest-books%3Afull-book");
    expect(screen.queryByRole("complementary", { name: "划线详情" })).toBeNull();
    expect(annotationApi.loadAnnotationThreads).not.toHaveBeenCalled();
  });
});
