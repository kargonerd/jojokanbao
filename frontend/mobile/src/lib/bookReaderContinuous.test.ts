// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JojoFragment } from "@jojo/content";
import { bookChapterAnchorId, createBookChapterMarkup } from "./bookDocument";
import {
  createBookReaderApplyAnnotationScript,
  createBookReaderBridgeScript,
  createBookReaderInsertChapterScript,
  createBookReaderRevealAnchorScript,
  type BookReaderAnnotationMarker,
  type BookReaderMessage,
} from "./bookReaderBridge";

const chapters = [
  { id: "chapter-1", title: "第一章", tocAnchorIds: ["heading", "shared"] },
  { id: "chapter-2", title: "第二章", tocAnchorIds: ["heading", "shared"] },
  { id: "chapter-3", title: "第三章", tocAnchorIds: ["heading", "shared"] },
];

function chapterMarkup(chapterId: string) {
  const chapter = chapters.find((entry) => entry.id === chapterId)!;
  const text = chapterId === "chapter-1" ? "前章正文，长度不同。" : "甲乙丙丁戊己";
  const otherChapterId = chapterId === "chapter-1" ? "chapter-2" : "chapter-1";
  const fragment: JojoFragment = {
    formatVersion: "jojo-fragment/1",
    itemId: "book",
    fragmentId: chapterId,
    type: "chapter",
    order: chapters.indexOf(chapter),
    title: chapter.title,
    body: {
      format: "html",
      value: `<h1 id="heading" data-test-offset="0" data-test-height="90">${chapter.title}</h1>`
        + `<p id="shared" data-test-offset="500" data-test-height="240">${text}</p>`
        + '<p data-test-offset="900"><a href="#shared">本章跳转</a>'
        + `<a data-target-id="${otherChapterId}" href="#shared">跨章跳转</a></p>`,
    },
    annotations: [],
    assetRefs: [],
  };
  return createBookChapterMarkup(fragment, {}).replace("<article ", '<article data-test-height="1600" ');
}

describe("continuous chapter WebView bridge", () => {
  let messages: BookReaderMessage[];
  let scrollPosition: number;
  let frames: FrameRequestCallback[];
  let removeListeners: Array<() => void>;
  let scrollYDescriptor: PropertyDescriptor | undefined;
  let rangeRectDescriptor: PropertyDescriptor | undefined;
  let scrollIntoViewDescriptor: PropertyDescriptor | undefined;

  function root(chapterId: string) {
    return document.querySelector<HTMLElement>(`article[data-reader-chapter-id="${chapterId}"]`)!;
  }

  function paragraph(chapterId: string) {
    return root(chapterId).querySelector<HTMLElement>('[data-reader-anchor-id="shared"]')!;
  }

  function slotHeight(slot: HTMLElement) {
    return Number(slot.querySelector<HTMLElement>("article")?.dataset.testHeight)
      || Number.parseFloat(slot.style.minHeight);
  }

  function documentTop(element: HTMLElement) {
    const slot = element.closest<HTMLElement>("[data-reader-chapter-slot]");
    let top = 0;
    for (const candidate of Array.from(document.querySelectorAll<HTMLElement>("[data-reader-chapter-slot]"))) {
      if (candidate === slot) break;
      top += slotHeight(candidate);
    }
    return (slot ? top : 0) + Number(element.dataset.testOffset || 0);
  }

  function execute(script: string) {
    // Evaluate exactly the serialized script sent to WebView, without exposing
    // module scope or transform helpers to the injected factory.
    window.eval(script);
  }

  function flushFrames() {
    const callbacks = frames.splice(0);
    for (const callback of callbacks) callback(performance.now());
  }

  function mount(insertedAnnotations: BookReaderAnnotationMarker[] = []) {
    document.body.dataset.readingMode = "scroll";
    document.body.innerHTML = chapterMarkup("chapter-1");
    execute(createBookReaderBridgeScript("start", false, [], undefined, undefined, undefined, {
      chapters,
      initialChapterId: "chapter-1",
    }));
    flushFrames();
    expect(messages).toContainEqual({ type: "reader-chapter-request", chapterId: "chapter-2" });
    execute(createBookReaderInsertChapterScript("chapter-2", chapterMarkup("chapter-2"), insertedAnnotations));
    expect(root("chapter-2")?.parentElement?.dataset.readerChapterSlot).toBe("chapter-2");
  }

  function select(startNode: Node, start: number, endNode = startNode, end = start + 3) {
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(startNode, start);
    range.setEnd(endNode, end);
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    return selection;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    messages = [];
    frames = [];
    removeListeners = [];
    scrollPosition = 0;
    scrollYDescriptor = Object.getOwnPropertyDescriptor(window, "scrollY");
    rangeRectDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
    scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    Object.defineProperty(window, "scrollY", { configurable: true, get: () => scrollPosition });
    vi.stubGlobal("innerWidth", 400);
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("ResizeObserver", undefined);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.stubGlobal("ReactNativeWebView", { postMessage: (value: string) => messages.push(JSON.parse(value) as BookReaderMessage) });
    vi.spyOn(window, "scrollTo").mockImplementation((x: number | ScrollToOptions, y?: number) => {
      scrollPosition = typeof x === "number" ? y ?? 0 : x.top ?? scrollPosition;
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const windowAdd = window.addEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
      windowAdd(type, listener, options);
      removeListeners.push(() => window.removeEventListener(type, listener, options));
    });
    const documentAdd = document.addEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
      documentAdd(type, listener, options);
      removeListeners.push(() => document.removeEventListener(type, listener, options));
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const height = this.matches("[data-reader-chapter-slot]") ? slotHeight(this)
        : Number(this.dataset.testHeight || 24);
      return new DOMRect(0, documentTop(this) - scrollPosition, 400, height);
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: function (this: Range) {
        const element = this.startContainer.nodeType === Node.ELEMENT_NODE
          ? this.startContainer as HTMLElement : this.startContainer.parentElement!;
        return new DOMRect(20, element.getBoundingClientRect().top + 20, 100, 24);
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(function (this: HTMLElement) {
        window.scrollTo(0, Math.max(0, documentTop(this) - 320));
        window.dispatchEvent(new Event("scroll"));
        document.dispatchEvent(new Event("scroll"));
      }),
    });
  });

  afterEach(() => {
    for (const remove of removeListeners) remove();
    window.getSelection()?.removeAllRanges();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (scrollYDescriptor) Object.defineProperty(window, "scrollY", scrollYDescriptor);
    if (rangeRectDescriptor) Object.defineProperty(Range.prototype, "getBoundingClientRect", rangeRectDescriptor);
    else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    if (scrollIntoViewDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoViewDescriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    for (const key of Object.keys(window)) {
      if (key.startsWith("__jojo")) Reflect.deleteProperty(window, key);
    }
    document.body.innerHTML = "";
    delete document.body.dataset.readingMode;
  });

  it("reports selected text offsets relative to the appended chapter rather than the whole document", () => {
    mount();
    const text = paragraph("chapter-2").firstChild!;

    select(text, 1);

    expect(messages.filter((message) => message.type === "reader-selection").at(-1)).toMatchObject({
      type: "reader-selection", chapterId: "chapter-2", text: "乙丙丁", start: 4, end: 7,
      prefix: "第二章甲", suffix: "戊己本章跳转跨章跳转",
      viewport: { width: 400, height: 800 },
    });
    expect(root("chapter-1").textContent!.length).toBeGreaterThan(7);
    expect(root("chapter-2").querySelector('[id="jojo-search-block:chapter-2:3"]')).not.toBeNull();
    expect(root("chapter-1").querySelector('[id="jojo-search-block:chapter-2:3"]')).toBeNull();
  });

  it("clears a selection spanning two chapters instead of persisting incompatible offsets", () => {
    mount();
    const secondText = paragraph("chapter-2").firstChild!;
    select(secondText, 1);
    const selectionCount = messages.filter((message) => message.type === "reader-selection").length;

    const selection = select(paragraph("chapter-1").firstChild!, 2, secondText, 4);

    expect(selection.rangeCount).toBe(0);
    expect(messages.at(-1)).toEqual({ type: "reader-selection-clear" });
    expect(messages.filter((message) => message.type === "reader-selection")).toHaveLength(selectionCount);
  });

  it("applies annotations to their explicit chapter even while another chapter is current", () => {
    mount();
    expect(messages.filter((message) => message.type === "reader-page").at(-1)).toMatchObject({ chapterId: "chapter-1" });

    execute(createBookReaderApplyAnnotationScript({ id: "saved-c2", chapterId: "chapter-2", start: 3, end: 6 }));

    expect(root("chapter-2").querySelector('mark[data-annotation-id="saved-c2"]')?.textContent).toBe("甲乙丙");
    expect(root("chapter-1").querySelector("mark")).toBeNull();
    execute(createBookReaderApplyAnnotationScript({ id: "saved-c1", chapterId: "chapter-1", start: 3, end: 6 }));
    expect(root("chapter-1").querySelector('mark[data-annotation-id="saved-c1"]')?.textContent).toBe("前章正");
    expect(root("chapter-2").querySelectorAll("mark")).toHaveLength(1);
  });

  it("captures up to 4000 selected characters with 80 characters of chapter-local context", () => {
    mount();
    const block = paragraph("chapter-2");
    block.textContent = "前".repeat(95) + "字".repeat(1200) + "后".repeat(95);
    select(block.firstChild!, 95, block.firstChild!, 1295);
    expect(messages.at(-1)).toMatchObject({ type: "reader-selection", chapterId: "chapter-2", text: "字".repeat(1200), prefix: "前".repeat(80), suffix: "后".repeat(80) });
    const selectionCount = messages.filter((message) => message.type === "reader-selection").length;
    block.textContent = "字".repeat(4001);
    const selection = select(block.firstChild!, 0, block.firstChild!, 4001);
    expect(selection.toString()).toHaveLength(4001);
    expect(messages.at(-1)).toEqual({ type: "reader-selection-clear" });
    expect(messages.filter((message) => message.type === "reader-selection")).toHaveLength(selectionCount);
  });

  it("finds a cloud highlight by quote when title rendering has shifted its offsets", () => {
    mount();
    execute(createBookReaderApplyAnnotationScript({ id: "cloud", chapterId: "chapter-2", start: 1, end: 4, quote: "乙丙丁", prefix: "甲", suffix: "戊己" }));
    expect(paragraph("chapter-2").querySelector('mark[data-annotation-id="cloud"]')?.textContent).toBe("乙丙丁");
    expect(root("chapter-1").querySelector("mark")).toBeNull();
  });

  it("chooses the repeated quote whose surrounding context matches, ahead of an unrelated nearby occurrence", () => {
    mount();
    const block = paragraph("chapter-2");
    block.textContent = "开篇相同句旧尾。目标前文相同句目标后文。";
    execute(createBookReaderApplyAnnotationScript({ id: "context", chapterId: "chapter-2", start: 4, end: 7, quote: "相同句", prefix: "目标前文", suffix: "目标后文" }));
    const mark = block.querySelector('mark[data-annotation-id="context"]')!;
    expect(mark.textContent).toBe("相同句");
    expect(mark.previousSibling?.textContent).toBe("开篇相同句旧尾。目标前文");
    expect(mark.nextSibling?.textContent).toBe("目标后文。");
  });

  it("prefers matching exact offsets and otherwise uses the nearest quote if context is unavailable", () => {
    mount();
    const block = paragraph("chapter-2");
    block.textContent = "前相同句中间第二相同句末尾";
    const source = root("chapter-2").textContent!;
    const first = source.indexOf("相同句");
    execute(createBookReaderApplyAnnotationScript({ id: "exact", chapterId: "chapter-2", start: first, end: first + 3, quote: "相同句", prefix: "第二", suffix: "末尾" }));
    expect(block.querySelector('mark[data-annotation-id="exact"]')?.previousSibling?.textContent).toBe("前");
    const second = source.lastIndexOf("相同句");
    execute(createBookReaderApplyAnnotationScript({ id: "nearest", chapterId: "chapter-2", start: second + 1, end: second + 4, quote: "相同句" }));
    expect(block.querySelector('mark[data-annotation-id="nearest"]')?.nextSibling?.textContent).toBe("末尾");
    execute(createBookReaderApplyAnnotationScript({ id: "missing", chapterId: "chapter-2", start: first, end: first + 3, quote: "根本不存在" }));
    expect(root("chapter-2").querySelector('mark[data-annotation-id="missing"]')).toBeNull();
  });

  it("restores saved annotations when the requested chapter is inserted", () => {
    mount([{ id: "inserted-c2", chapterId: "chapter-2", start: 4, end: 7 }]);

    expect(root("chapter-2").querySelector('mark[data-annotation-id="inserted-c2"]')?.textContent).toBe("乙丙丁");
    expect(root("chapter-1").querySelector("mark")).toBeNull();
  });

  it("reveals the requested chapter when multiple chapters have the same source anchor", () => {
    mount();
    const first = paragraph("chapter-1");
    const second = paragraph("chapter-2");

    execute(createBookReaderRevealAnchorScript("shared", "chapter-2"));
    vi.advanceTimersByTime(100);

    expect(second.getAttribute("data-book-jump-target")).toBe("true");
    expect(first.hasAttribute("data-book-jump-target")).toBe(false);
    expect(second.getBoundingClientRect().top).toBe(320);
    expect(messages.filter((message) => message.type === "reader-page").at(-1)).toMatchObject({ chapterId: "chapter-2" });
    execute(createBookReaderRevealAnchorScript(bookChapterAnchorId("chapter-1", "shared"), "chapter-1"));
    vi.advanceTimersByTime(100);
    expect(first.getAttribute("data-book-jump-target")).toBe("true");
    expect(second.hasAttribute("data-book-jump-target")).toBe(false);
    expect(messages.filter((message) => message.type === "reader-page").at(-1)).toMatchObject({ chapterId: "chapter-1" });
  });

  it("keeps local links inside their chapter and reports the original target for cross-chapter links", () => {
    mount();
    const second = root("chapter-2");
    const localLink = second.querySelector<HTMLAnchorElement>("a:not([data-target-id])")!;

    localLink.click();

    expect(paragraph("chapter-2").hasAttribute("data-book-jump-target")).toBe(true);
    expect(paragraph("chapter-1").hasAttribute("data-book-jump-target")).toBe(false);
    expect(messages.filter((message) => message.type === "reader-internal-link")).toHaveLength(0);
    second.querySelector<HTMLAnchorElement>('a[data-target-id="chapter-1"]')!.click();
    expect(messages.at(-1)).toMatchObject({ type: "reader-internal-link", chapterId: "chapter-1", anchorId: "shared", sourceChapterId: "chapter-2", sourceProgress: expect.any(Number) });
  });
});
