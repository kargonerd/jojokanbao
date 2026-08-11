import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookReader } from "../src/rag/components/BookReader";

class ResizeObserverMock {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

describe("BookReader", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200, writable: true });
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function renderReader(onChapterChange = vi.fn()) {
    const view = render(
      <MemoryRouter>
        <BookReader
          bookTitle="测试书"
          characterCount={12000}
          logicalChapterCount={40}
          chapters={[{ id: "chapter-1", title: "第一章" }, { id: "chapter-2", title: "第二章" }]}
          toc={[
            { id: "toc-1", targetId: "chapter-1", title: "第一章", depth: 0 },
            { id: "toc-2", targetId: "chapter-2", title: "第二章", depth: 0 },
          ]}
          activeChapterId="chapter-1"
          chapterKey="chapter-1"
          backHref="/rag/chat"
          onChapterChange={onChapterChange}
        >
          <h1>第一章</h1>
          <p>这是正文。</p>
        </BookReader>
      </MemoryRouter>,
    );
    return { ...view, onChapterChange };
  }

  it("uses a real two-column paged layout on desktop by default", () => {
    const { container } = renderReader();
    const flow = container.querySelector<HTMLElement>("[data-book-page-flow]");
    const toolbar = container.querySelector<HTMLElement>("[data-book-toolbar]");
    expect(flow).not.toBeNull();
    expect(flow?.style.columnCount).toBe("2");
    expect(toolbar?.className).toContain("right-5");
    expect(toolbar?.className).not.toContain("left-5");
    expect(screen.getByRole("button", { name: "切换阅读模式" }).textContent).toBe("双页");
    expect(screen.queryByText("上一节")).toBeNull();
  });

  it("switches to scrolling mode and remembers the choice", async () => {
    renderReader();
    fireEvent.click(screen.getByRole("button", { name: "阅读设置" }));
    fireEvent.click(screen.getByRole("button", { name: "上下滚动" }));
    expect(screen.queryByText(/\/ 1 页/)).toBeNull();
    await waitFor(() => expect(window.localStorage.getItem("jojo-reader-mode")).toBe("scroll"));
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

  it("uses a perspective page turn before applying the next page", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    const onChapterChange = vi.fn();
    const { container } = renderReader(onChapterChange);
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(container.querySelector(".book-page-turn-sheet--next")).not.toBeNull();
    expect(onChapterChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(250));
    expect(onChapterChange).toHaveBeenCalledWith("chapter-2");
    act(() => vi.advanceTimersByTime(310));
    expect(container.querySelector(".book-page-turn-sheet--next")).toBeNull();
    vi.useRealTimers();
  });

  it("selects chapters from the reusable table of contents drawer", () => {
    const onChapterChange = vi.fn();
    renderReader(onChapterChange);
    fireEvent.click(screen.getByRole("button", { name: "打开目录" }));
    expect(screen.getByText(/40 章/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "第二章" }));
    expect(onChapterChange).toHaveBeenCalledWith("chapter-2");
  });
});
