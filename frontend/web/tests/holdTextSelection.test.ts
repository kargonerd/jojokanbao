import { describe, expect, it } from "vitest";
import { createHoldTextSelection, expandWordAround } from "../src/rag/holdTextSelection";

function textNode(text: string): Text {
  return { nodeType: Node.TEXT_NODE, textContent: text, ownerDocument: { createRange: () => fakeRange(text) } } as unknown as Text;
}

function fakeRange(text = "示例文本内容") {
  const range = { start: 0, end: 0 };
  const built = {
    setStart(_node: Text, s: number) { range.start = s; },
    setEnd(_node: Text, e: number) { range.end = e; },
    toString: () => text.slice(range.start, range.end),
  };
  return built as unknown as Range;
}

function fakeSurface(initialTop = 0) {
  return {
    scrollTop: initialTop,
    scrollLeft: 0,
    style: { overflow: "" },
  } as unknown as HTMLElement & { style: { overflow: string } };
}

function immediateQueue() {
  let pending: Array<{ task: () => void; cancelled?: boolean }> = [];
  return {
    schedule: (task: () => void) => {
      const entry: { task: () => void; cancelled?: boolean } = { task };
      pending.push(entry);
      return () => { entry.cancelled = true; };
    },
    flush() {
      const batch = pending;
      pending = [];
      batch.filter((entry) => !entry.cancelled).forEach(({ task }) => task());
    },
  };
}

function touchEvent(overrides: { touches?: Array<{ clientX: number; clientY: number }>; target?: Element | null } = {}) {
  return {
    touches: overrides.touches ?? [{ clientX: 100, clientY: 200 }],
    target: overrides.target ?? null,
  } as unknown as TouchEvent;
}

function setup(options: { scrollTop?: number; selectionCollapsed?: boolean; blocked?: boolean; hitTest?: () => Range | null; driftTriggers?: boolean; freeze?: (surface: HTMLElement) => void } = {}) {
  const surface = fakeSurface(options.scrollTop ?? 0);
  const selectionCalls: string[] = [];
  const queue = immediateQueue();
  const selection = {
    isCollapsed: options.selectionCollapsed ?? true,
    removeAllRanges: () => selectionCalls.push("removeAllRanges"),
    addRange: () => selectionCalls.push("addRange"),
  } as unknown as Selection;
  let frozen = 0;
  const hold = createHoldTextSelection({
    surface: () => surface,
    selection: () => selection,
    schedule: queue.schedule,
    hitTest: options.hitTest ?? (() => {
      const node = textNode("示例文本内容");
      return { startContainer: node, startOffset: 2 } as unknown as Range;
    }),
    blocked: () => Boolean(options.blocked),
    ...(options.freeze ? { freeze: options.freeze } : {}),
    driftTriggers: options.driftTriggers,
  });
  return { surface, selectionCalls, queue, hold };
}

describe("expandWordAround", () => {
  it("expands a caret inside a CJK+digit run into the full run", () => {
    const node = textNode("19世纪40年代初，马克思");
    expect(expandWordAround(node, 5)).toEqual({ start: 0, end: 9 });
  });

  it("expands a caret inside a latin word", () => {
    const node = textNode("the Manifesto of the party");
    expect(expandWordAround(node, 8)).toEqual({ start: 4, end: 13 });
  });

  it("expands backward when the caret sits right after a run", () => {
    const node = textNode("词，下一句");
    expect(expandWordAround(node, 1)).toEqual({ start: 0, end: 1 });
  });

  it("keeps a single punctuation character under the finger", () => {
    const node = textNode("——引号");
    expect(expandWordAround(node, 1)).toEqual({ start: 1, end: 2 });
  });

  it("returns null past the end of the text", () => {
    const node = textNode("词");
    expect(expandWordAround(node, 5)).toBeNull();
  });

  it("caps a long CJK run at a phrase window centred on the caret", () => {
    const node = textNode("这是一段没有标点的很长正文内容用来验证长按兜底选中的窗口大小");
    const picked = expandWordAround(node, 20)!;
    expect(picked.end - picked.start).toBeLessThanOrEqual(10);
    expect(picked.start).toBeLessThanOrEqual(20);
    expect(picked.end).toBeGreaterThan(20);
  });

  it("keeps a long latin run intact (whole word only here)", () => {
    const node = textNode("internationalization");
    expect(expandWordAround(node, 8)).toEqual({ start: 0, end: 20 });
  });
});

describe("hold text selection fallback", () => {
  it("never selects when the surface stayed put during the hold", () => {
    const { selectionCalls, queue, hold } = setup({ scrollTop: 0 });
    hold.onTouchStart(touchEvent());
    queue.flush();
    expect(selectionCalls).toEqual([]);
  });

  it("selects the word under a still finger when the surface glided", () => {
    const { surface, selectionCalls, queue, hold } = setup({ scrollTop: 500 });
    hold.onTouchStart(touchEvent());
    // The glide moved the surface while the finger stayed still.
    surface.scrollTop = 620;
    queue.flush();
    expect(selectionCalls).toEqual(["removeAllRanges", "addRange"]);
    // The glide must be interrupted while the word is captured.
    expect(surface.style.overflow).toBe("hidden");
    // ... and restored again shortly after.
    queue.flush();
    expect(surface.style.overflow).toBe("");
  });

  it("skips when a selection already exists", () => {
    const { selectionCalls, queue, hold } = setup({ scrollTop: 500, selectionCollapsed: false });
    hold.onTouchStart(touchEvent());
    queue.flush();
    expect(selectionCalls).toEqual([]);
  });

  it("skips when an overlay owns the screen", () => {
    const { selectionCalls, queue, hold } = setup({ scrollTop: 500, blocked: true });
    hold.onTouchStart(touchEvent());
    queue.flush();
    expect(selectionCalls).toEqual([]);
  });

  it("skips when the hit test finds nothing selectable", () => {
    const { selectionCalls, queue, hold } = setup({ scrollTop: 500, hitTest: () => null });
    hold.onTouchStart(touchEvent());
    queue.flush();
    expect(selectionCalls).toEqual([]);
  });

  it("cancels the hold once the finger moves", () => {
    const { surface, selectionCalls, queue, hold } = setup({ scrollTop: 500 });
    hold.onTouchStart(touchEvent());
    hold.onTouchMove(touchEvent({ touches: [{ clientX: 160, clientY: 260 }] }));
    surface.scrollTop = 620;
    queue.flush();
    expect(selectionCalls).toEqual([]);
    expect(surface.style.overflow).toBe("");
  });

  it("cancels on multi-touch and on interactive targets", () => {
    const { surface, selectionCalls, queue, hold } = setup({ scrollTop: 500 });
    hold.onTouchStart(touchEvent({ touches: [{ clientX: 1, clientY: 1 }, { clientX: 2, clientY: 2 }] }));
    queue.flush();
    expect(selectionCalls).toEqual([]);
    const button = { closest: () => ({}) } as unknown as Element;
    hold.onTouchStart(touchEvent({ target: button }));
    surface.scrollTop = 620;
    queue.flush();
    expect(selectionCalls).toEqual([]);
    expect(surface.style.overflow).toBe("");
  });

  it("a released finger cancels the pending hold", () => {
    const { surface, selectionCalls, queue, hold } = setup({ scrollTop: 500 });
    hold.onTouchStart(touchEvent());
    hold.onTouchEnd();
    surface.scrollTop = 620;
    queue.flush();
    expect(selectionCalls).toEqual([]);
  });

  it("paged: a drifting still finger triggers the fallback", () => {
    const { selectionCalls, queue, hold } = setup({ scrollTop: 0, driftTriggers: true, freeze: () => {} });
    hold.onTouchStart(touchEvent());
    // A real finger always drifts a few pixels inside the drag threshold.
    hold.onTouchMove(touchEvent({ touches: [{ clientX: 103, clientY: 203 }] }));
    hold.onTouchMove(touchEvent({ touches: [{ clientX: 102, clientY: 202 }] }));
    queue.flush();
    expect(selectionCalls).toEqual(["removeAllRanges", "addRange"]);
  });

  it("paged: a perfectly still finger on a still surface stays native", () => {
    const { selectionCalls, queue, hold } = setup({ scrollTop: 0, driftTriggers: true });
    hold.onTouchStart(touchEvent());
    queue.flush();
    expect(selectionCalls).toEqual([]);
  });

  it("paged: a finger drift alone does not trigger without the flag", () => {
    const { selectionCalls, queue, hold } = setup({ scrollTop: 0 });
    hold.onTouchStart(touchEvent());
    hold.onTouchMove(touchEvent({ touches: [{ clientX: 104, clientY: 204 }] }));
    queue.flush();
    expect(selectionCalls).toEqual([]);
  });

  it("paged: a surface glide (page turn) triggers the fallback without drift", () => {
    const { surface, selectionCalls, queue, hold } = setup({ scrollTop: 0, driftTriggers: true });
    hold.onTouchStart(touchEvent());
    // The page-turn animation moves the flow horizontally.
    surface.scrollLeft = 412;
    queue.flush();
    expect(selectionCalls).toEqual(["removeAllRanges", "addRange"]);
  });

  it("uses the injected freeze instead of the overflow toggle when provided", () => {
    let frozen = 0;
    const { surface, selectionCalls, queue, hold } = setup({
      scrollTop: 500,
      freeze: () => { frozen += 1; },
    });
    hold.onTouchStart(touchEvent());
    surface.scrollTop = 620;
    queue.flush();
    expect(selectionCalls).toEqual(["removeAllRanges", "addRange"]);
    expect(frozen).toBe(1);
  });
});
