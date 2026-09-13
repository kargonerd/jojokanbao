import { createRef, useRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContinuousBookContent, type ContinuousBookContentHandle } from "../src/rag/components/ContinuousBookContent";

const chapters = Array.from({ length: 7 }, (_, index) => ({ id: `c${index + 1}`, title: `第${index + 1}章` }));
let resize: () => void;
let height = 1000;

beforeEach(() => {
  height = 1000;
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const scroll = document.querySelector<HTMLElement>("[data-testid='scroll']");
    const section = this.matches("[data-book-chapter-id]") ? this : this.closest("[data-book-chapter-id]");
    const sections = Array.from(document.querySelectorAll("[data-book-chapter-id]"));
    const index = section ? sections.indexOf(section) : -1;
    const top = index < 0 ? 0 : index * height - (scroll?.scrollTop ?? 0);
    const size = this === scroll ? 200 : index < 0 ? sections.length * height : height;
    return { x: 0, y: top, top, bottom: top + size, left: 0, right: 400, width: 400, height: size, toJSON() {} };
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.hasAttribute("data-book-chapter-id") ? height : 200; });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => document.querySelectorAll("[data-book-chapter-id]").length * height);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(loadChapter = vi.fn(async (id: string) => <p>{id} 正文</p>), initialChapterId = "c2") {
  const handle = createRef<ContinuousBookContentHandle>();
  const onPosition = vi.fn();
  function Harness() {
    const scrollRef = useRef<HTMLDivElement>(null);
    return <div ref={scrollRef} data-testid="scroll"><ContinuousBookContent ref={handle} chapters={chapters} initialChapterId={initialChapterId} loadChapter={loadChapter} scrollRef={scrollRef} onPosition={onPosition} onReady={() => {}} /></div>;
  }
  render(<Harness />);
  return { handle, loadChapter, onPosition, scroll: screen.getByTestId("scroll") };
}

describe("continuous book scrolling", () => {
  it("prepends without moving the visible paragraph and retains DOM when scrolling in both directions", async () => {
    const { scroll, onPosition, loadChapter } = setup();
    const paragraph = await screen.findByText("c2 正文");
    await screen.findByText("c1 正文");
    expect(scroll.scrollTop).toBe(1000);
    expect(paragraph.getBoundingClientRect().top).toBe(0);
    act(() => { scroll.scrollTop = 1850; fireEvent.scroll(scroll); });
    await screen.findByText("c3 正文");
    expect(screen.getByText("c2 正文")).toBe(paragraph);
    expect(scroll.scrollTop).toBe(1850);
    act(() => { scroll.scrollTop = 100; fireEvent.scroll(scroll); });
    await waitFor(() => expect(onPosition).toHaveBeenLastCalledWith("c1", 16));
    expect(screen.getByText("c3 正文")).toBeTruthy();
    expect(loadChapter.mock.calls.map(([id]) => id)).toEqual(["c2", "c1", "c3"]);
    expect(screen.queryByRole("button", { name: /下一章|上一章/ })).toBeNull();
  });

  it("keeps the reading anchor stable when an earlier image changes chapter height", async () => {
    const { scroll } = setup();
    await screen.findByText("c1 正文");
    const paragraph = screen.getByText("c2 正文");
    act(() => { height = 1200; resize(); });
    expect(scroll.scrollTop).toBe(1200);
    expect(paragraph.getBoundingClientRect().top).toBe(0);
  });

  it("seeks within retained chapters without reloading or dropping surrounding content", async () => {
    const { scroll, handle, loadChapter } = setup();
    await screen.findByText("c1 正文");
    const c2 = screen.getByText("c2 正文");
    act(() => handle.current?.seek("c1", 50));
    expect(scroll.scrollTop).toBe(440);
    expect(screen.getByText("c2 正文")).toBe(c2);
    expect(loadChapter).toHaveBeenCalledTimes(2);
  });

  it("does not let a late chapter from an old jump replace the new destination", async () => {
    let resolveOld!: (node: React.ReactNode) => void;
    const load = vi.fn((id: string): Promise<React.ReactNode> => id === "c2" ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve(<p>{id} 正文</p>));
    const { handle } = setup(load);
    act(() => handle.current?.seek("c6"));
    await screen.findByText("c6 正文");
    await act(async () => resolveOld(<p>c2 迟到正文</p>));
    expect(screen.queryByText("c2 迟到正文")).toBeNull();
    expect(screen.getByText("c6 正文")).toBeTruthy();
  });

  it("retains the current chapter on edge failure and retries only the failed chapter", async () => {
    const load = vi.fn(async (id: string) => { if (id === "c1" && load.mock.calls.filter(([value]) => value === "c1").length === 1) throw new Error("offline"); return <p>{id} 正文</p>; });
    const { scroll } = setup(load);
    const paragraph = await screen.findByText("c2 正文");
    const retry = await screen.findByRole("button", { name: "重试" });
    fireEvent.click(retry);
    await screen.findByText("c1 正文");
    expect(screen.getByText("c2 正文")).toBe(paragraph);
    expect(scroll.scrollTop).toBe(1000);
    expect(load.mock.calls.filter(([id]) => id === "c2")).toHaveLength(1);
  });
});
