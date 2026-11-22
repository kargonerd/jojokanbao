import { describe, expect, it } from "vitest";
import { createNativeMenuSuppressor, type MenuSelection } from "../src/rag/nativeSelectionMenu";

function fakeSelection(options: { collapsed?: boolean; detachOnAdd?: boolean } = {}) {
  const calls: string[] = [];
  const range = { fake: true } as unknown as Range;
  const selection: MenuSelection & { calls: string[] } = {
    calls,
    isCollapsed: options.collapsed ?? false,
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges: () => calls.push("removeAllRanges"),
    addRange: (applied: Range) => {
      if (options.detachOnAdd) throw new Error("detached");
      calls.push(applied === range ? "addRange(same)" : "addRange(other)");
    },
  };
  return { selection, calls, range };
}

function immediateQueue() {
  const tasks: Array<() => void> = [];
  return {
    tasks,
    schedule: (task: () => void) => { tasks.push(task); },
    flush() {
      while (tasks.length) tasks.splice(0).forEach((task) => task());
    },
  };
}

describe("native selection menu suppressor", () => {
  it("removes and re-applies the very same range across deferred steps", () => {
    const queue = immediateQueue();
    const { selection, calls, range } = fakeSelection();
    const suppressor = createNativeMenuSuppressor({
      selection: () => selection,
      schedule: queue.schedule,
    });

    suppressor.arm();
    queue.flush();

    expect(calls).toEqual(["removeAllRanges", "addRange(same)"]);
    expect(suppressor.busy).toBe(false);
    expect(range).toBeTruthy();
  });

  it("stays busy until the whole sequence has landed", () => {
    const queue = immediateQueue();
    const { selection } = fakeSelection();
    const suppressor = createNativeMenuSuppressor({
      selection: () => selection,
      schedule: queue.schedule,
    });

    suppressor.arm();
    // Only the removal has been scheduled so far.
    expect(suppressor.busy).toBe(true);
    queue.tasks.splice(0).forEach((task) => task());
    expect(suppressor.busy).toBe(true);
    queue.tasks.splice(0).forEach((task) => task());
    expect(suppressor.busy).toBe(true);
    queue.tasks.splice(0).forEach((task) => task());
    expect(suppressor.busy).toBe(false);
  });

  it("ignores collapsed and empty selections", () => {
    const queue = immediateQueue();
    const { selection } = fakeSelection({ collapsed: true });
    const suppressor = createNativeMenuSuppressor({
      selection: () => selection,
      schedule: queue.schedule,
    });

    suppressor.arm();

    expect(queue.tasks).toHaveLength(0);
    expect(suppressor.busy).toBe(false);
  });

  it("does not stack a second sequence while one is in flight", () => {
    const queue = immediateQueue();
    const { selection, calls } = fakeSelection();
    const suppressor = createNativeMenuSuppressor({
      selection: () => selection,
      schedule: queue.schedule,
    });

    suppressor.arm();
    suppressor.arm();
    suppressor.arm();
    queue.flush();

    expect(calls).toEqual(["removeAllRanges", "addRange(same)"]);
  });

  it("survives a range that re-rendered away mid-flight", () => {
    const queue = immediateQueue();
    const { selection, calls } = fakeSelection({ detachOnAdd: true });
    const suppressor = createNativeMenuSuppressor({
      selection: () => selection,
      schedule: queue.schedule,
    });

    suppressor.arm();
    queue.flush();

    expect(calls).toEqual(["removeAllRanges"]);
    expect(suppressor.busy).toBe(false);
  });
});
