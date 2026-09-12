// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JojoFragment } from "@jojo/content";
import { bookChapterAnchorId, createBookChapterMarkup } from "./bookDocument";
import { createContinuousBookScroll } from "./continuousBookScroll";

const chapters = Array.from({ length: 7 }, (_, index) => ({
  id: `chapter-${index + 1}`,
  title: `第 ${index + 1} 章`,
  tocAnchorIds: ["heading", "paragraph"],
}));

function chapterMarkup(id: string, height = 1600): string {
  const fragment: JojoFragment = {
    formatVersion: "jojo-fragment/1",
    itemId: "book",
    fragmentId: id,
    type: "chapter",
    title: id,
    order: chapters.findIndex((chapter) => chapter.id === id),
    body: {
      format: "html",
      value: `<h1 id="heading" data-test-offset="0" data-test-height="90">${id}</h1>`
        + '<p id="paragraph" data-test-offset="160" data-test-height="280">首段正文<sup data-annotation-id="note-1"></sup></p>'
        + '<p id="last-paragraph" data-test-offset="920" data-test-height="300">后段正文</p>',
    },
    assetRefs: [],
    annotations: [{ id: "note-1", targetId: id, kind: "footnote", label: "1", body: { format: "text", value: "注释正文" } }],
  };
  return createBookChapterMarkup(fragment, {}).replace("<article ", `<article data-test-height="${height}" `);
}

describe("continuous book scroll", () => {
  let scrollPosition = 0;
  let scrollYDescriptor: PropertyDescriptor | undefined;
  let resizeCallbacks: ResizeObserverCallback[];
  let removeListeners: Array<() => void>;

  // jsdom has no layout. These boxes model vertical document flow: unloaded
  // slots keep their estimated height, and loaded chapters use their real size.
  function slotHeight(slot: HTMLElement): number {
    const article = slot.querySelector<HTMLElement>("article[data-reader-chapter-id]");
    return article ? Number(article.dataset.testHeight) : Number.parseFloat(slot.style.minHeight);
  }

  function slotTop(slot: HTMLElement): number {
    let position = 0;
    for (const candidate of Array.from(document.querySelectorAll<HTMLElement>("[data-reader-chapter-slot]"))) {
      if (candidate === slot) break;
      position += slotHeight(candidate);
    }
    return position;
  }

  function moveTo(y: number) {
    window.scrollTo(0, y);
    window.dispatchEvent(new Event("scroll"));
  }

  function resize() {
    for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
  }

  function mount(initialChapterId = "chapter-2") {
    document.body.innerHTML = chapterMarkup(initialChapterId);
    const initialRoot = document.querySelector<HTMLElement>("article")!;
    const post = vi.fn();
    const prepare = vi.fn();
    const changed = vi.fn();
    const reader = createContinuousBookScroll(chapters, initialChapterId, post, prepare, changed)!;
    return { reader, initialRoot, post, prepare, changed };
  }

  beforeEach(() => {
    scrollPosition = 0;
    resizeCallbacks = [];
    removeListeners = [];
    document.body.innerHTML = "";
    scrollYDescriptor = Object.getOwnPropertyDescriptor(window, "scrollY");
    Object.defineProperty(window, "scrollY", { configurable: true, get: () => scrollPosition });
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(window, "scrollTo").mockImplementation((x: number | ScrollToOptions, y?: number) => {
      scrollPosition = typeof x === "number" ? y ?? 0 : x.top ?? scrollPosition;
    });
    const addListener = window.addEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
      addListener(type, listener, options);
      removeListeners.push(() => window.removeEventListener(type, listener, options));
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const slot = this.closest<HTMLElement>("[data-reader-chapter-slot]");
      let documentTop = slot ? slotTop(slot) : 0;
      let height = 0;
      if (this === slot) height = slotHeight(slot);
      else if (this.matches("article[data-reader-chapter-id]")) height = Number(this.dataset.testHeight);
      else {
        documentTop += Number(this.dataset.testOffset || 0);
        height = Number(this.dataset.testHeight || 24);
      }
      return new DOMRect(0, documentTop - scrollPosition, 400, height);
    });
  });

  afterEach(() => {
    for (const remove of removeListeners) remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (scrollYDescriptor) Object.defineProperty(window, "scrollY", scrollYDescriptor);
    document.body.innerHTML = "";
  });

  it("appends chapters without replacing mounted content or changing the viewport", () => {
    const { reader, initialRoot, prepare } = mount("chapter-1");
    const paragraph = reader.findAnchor("chapter-1", "paragraph")!;
    const text = paragraph.firstChild!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 2);
    selection.removeAllRanges();
    selection.addRange(range);
    paragraph.dataset.readerLiveState = "retained";
    reader.start();
    moveTo(300);
    const before = paragraph.getBoundingClientRect().top;
    const annotations = [{ id: "saved-highlight" }];

    reader.insert("chapter-2", chapterMarkup("chapter-2", 1900), annotations);

    expect(reader.root("chapter-1")).toBe(initialRoot);
    expect(reader.findAnchor("chapter-1", "paragraph")).toBe(paragraph);
    expect(paragraph.dataset.readerLiveState).toBe("retained");
    expect(selection.anchorNode).toBe(text);
    expect(selection.toString()).toBe("首段");
    expect(paragraph.getBoundingClientRect().top).toBe(before);
    expect(window.scrollY).toBe(300);
    expect(reader.current()?.chapterId).toBe("chapter-1");
    expect(prepare).toHaveBeenCalledExactlyOnceWith(reader.root("chapter-2"), annotations);
    expect(Array.from(document.querySelectorAll<HTMLElement>("article[data-reader-chapter-id]"), (article) => article.dataset.readerChapterId))
      .toEqual(["chapter-1", "chapter-2"]);

    const appendedRoot = reader.root("chapter-2");
    reader.insert("chapter-2", chapterMarkup("chapter-2", 2400));
    expect(reader.root("chapter-2")).toBe(appendedRoot);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("preserves the visible paragraph when a preceding placeholder becomes a longer chapter", () => {
    const { reader, initialRoot } = mount();
    reader.start();
    moveTo(1100);
    const paragraph = reader.findAnchor("chapter-2", "paragraph")!;
    const viewportTop = paragraph.getBoundingClientRect().top;
    expect(viewportTop).toBe(-140);

    reader.insert("chapter-1", chapterMarkup("chapter-1", 2400));

    expect(reader.root("chapter-2")).toBe(initialRoot);
    expect(paragraph.isConnected).toBe(true);
    expect(paragraph.getBoundingClientRect().top).toBe(viewportTop);
    expect(window.scrollY).toBe(2700);
    expect(reader.current()?.chapterId).toBe("chapter-2");
  });

  it("updates the active chapter and local progress while scrolling backward through retained chapters", () => {
    const { reader } = mount();
    reader.insert("chapter-1", chapterMarkup("chapter-1", 1800));
    reader.insert("chapter-3", chapterMarkup("chapter-3", 1400));
    reader.start();
    expect(reader.seek("chapter-3", 0.5)).toBe(true);
    expect(reader.current()).toMatchObject({ chapterId: "chapter-3", progress: 0.5 });

    const secondTop = slotTop(reader.root("chapter-2")!.parentElement!);
    moveTo(secondTop + 400);
    const laterProgress = reader.current()!.progress;
    expect(reader.current()?.chapterId).toBe("chapter-2");
    moveTo(secondTop + 100);
    expect(reader.current()?.chapterId).toBe("chapter-2");
    expect(reader.current()!.progress).toBeLessThan(laterProgress);
    moveTo(200);
    expect(reader.current()?.chapterId).toBe("chapter-1");
    expect(reader.root()).toBe(reader.root("chapter-1"));
    expect(reader.root("chapter-3")?.isConnected).toBe(true);
  });

  it("resolves repeated source anchors and footnotes only inside their requested chapter", () => {
    const { reader } = mount();
    reader.insert("chapter-1", chapterMarkup("chapter-1"));
    const first = reader.findAnchor("chapter-1", "paragraph")!;
    const second = reader.findAnchor("chapter-2", "paragraph")!;

    expect(first).not.toBe(second);
    expect(first.closest("article")).toBe(reader.root("chapter-1"));
    expect(second.closest("article")).toBe(reader.root("chapter-2"));
    expect(reader.findAnchor("chapter-2", bookChapterAnchorId("chapter-2", "paragraph"))).toBe(second);
    expect(reader.findAnchor("chapter-1", bookChapterAnchorId("chapter-2", "paragraph"))).toBeUndefined();
    expect(reader.findAnchor("chapter-3", "paragraph")).toBeUndefined();
    expect(reader.anchors("chapter-2")).toEqual(["heading", "paragraph"]);

    for (const id of ["chapter-1", "chapter-2"]) {
      const note = reader.findAnchor(id, "note-1")!;
      const link = reader.root(id)!.querySelector<HTMLAnchorElement>('a[data-reader-href-anchor-id="note-1"]')!;
      expect(document.getElementById(decodeURIComponent(link.getAttribute("href")!.slice(1)))).toBe(note);
      expect(note.closest("article")).toBe(reader.root(id));
    }
  });

  it("deduplicates nearby loading and repeated seeks until the requested chapter arrives", () => {
    const { reader, post } = mount("chapter-4");
    expect(post).not.toHaveBeenCalled();
    reader.start();
    reader.start();
    moveTo(window.scrollY + 1);
    moveTo(window.scrollY + 1);
    resize();

    expect(post.mock.calls.map(([message]) => message)).toEqual([
      { type: "reader-chapter-request", chapterId: "chapter-3" },
      { type: "reader-chapter-request", chapterId: "chapter-5" },
    ]);
    expect(reader.seek("chapter-6")).toBe(false);
    expect(reader.seek("chapter-6", 0.5)).toBe(false);
    expect(post.mock.calls.filter(([message]) => message.chapterId === "chapter-6")).toHaveLength(1);
    reader.insert("chapter-5", chapterMarkup("chapter-5"));
    reader.start();
    moveTo(window.scrollY);
    expect(post.mock.calls.filter(([message]) => message.chapterId === "chapter-5")).toHaveLength(1);
  });

  it("retries a failed chapter without dropping its loaded neighbors or their reading position", () => {
    const { reader, initialRoot, post } = mount();
    reader.start();
    reader.insert("chapter-1", chapterMarkup("chapter-1", 1800));
    const previousRoot = reader.root("chapter-1");
    moveTo(2100);
    const paragraph = reader.findAnchor("chapter-2", "paragraph")!;
    const viewportTop = paragraph.getBoundingClientRect().top;

    reader.fail("chapter-3");
    const failedSlot = document.querySelector<HTMLElement>('[data-reader-chapter-slot="chapter-3"]')!;
    expect(failedSlot.textContent).toContain("章节暂时无法读取");
    reader.start();
    resize();
    moveTo(window.scrollY);
    expect(post.mock.calls.filter(([message]) => message.chapterId === "chapter-3")).toHaveLength(1);

    failedSlot.querySelector<HTMLButtonElement>("button")!.click();
    expect(post.mock.calls.filter(([message]) => message.chapterId === "chapter-3")).toHaveLength(2);
    expect(failedSlot.querySelector('[role="status"]')?.textContent).toBe("正在读取章节…");
    expect(reader.root("chapter-1")).toBe(previousRoot);
    expect(reader.root("chapter-2")).toBe(initialRoot);
    reader.insert("chapter-3", chapterMarkup("chapter-3", 1400));

    expect(reader.root("chapter-3")?.isConnected).toBe(true);
    expect(failedSlot.querySelector("button")).toBeNull();
    expect(reader.root("chapter-1")).toBe(previousRoot);
    expect(reader.root("chapter-2")).toBe(initialRoot);
    expect(reader.current()?.chapterId).toBe("chapter-2");
    expect(paragraph.getBoundingClientRect().top).toBe(viewportTop);
  });

  it("keeps the visible paragraph stable when an earlier chapter grows after image loading", () => {
    const { reader } = mount();
    reader.start();
    reader.insert("chapter-1", chapterMarkup("chapter-1", 1800));
    moveTo(2100);
    const paragraph = reader.findAnchor("chapter-2", "paragraph")!;
    const viewportTop = paragraph.getBoundingClientRect().top;
    reader.root("chapter-1")!.dataset.testHeight = "2300";

    resize();

    expect(window.scrollY).toBe(2600);
    expect(paragraph.getBoundingClientRect().top).toBe(viewportTop);
    expect(reader.current()?.chapterId).toBe("chapter-2");
  });
});
