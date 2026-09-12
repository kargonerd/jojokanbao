import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBookReadingTime, useReadingStatsStore } from "../src/reading/readingStats";

let hidden = false;
let focused = true;

function advance(seconds: number) {
  act(() => { vi.advanceTimersByTime(seconds * 1000); });
}

function activity(type: "pointerdown" | "keydown" | "scroll" = "pointerdown") {
  act(() => { window.dispatchEvent(new Event(type)); });
}

function visibility(value: boolean) {
  hidden = value;
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
}

function focus(value: boolean) {
  focused = value;
  act(() => { window.dispatchEvent(new Event(value ? "focus" : "blur")); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-12T10:00:00Z"));
  hidden = false;
  focused = true;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  window.localStorage.clear();
  useReadingStatsStore.setState({ seconds: {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("active book reading time", () => {
  it("accumulates foreground reading at checkpoints and persists it on this device", () => {
    const { result } = renderHook(() => useBookReadingTime("reader:book", true));
    advance(10);
    expect(result.current).toBe(10);
    advance(5);
    activity("scroll");
    expect(result.current).toBe(10);
    advance(5);
    expect(result.current).toBe(20);
    expect(JSON.parse(window.localStorage.getItem("jojo-reading-stats")!).state.seconds["reader:book"]).toBe(20);
  });

  it("flushes the foreground tail when hidden and never counts hidden time", () => {
    const { result } = renderHook(() => useBookReadingTime("reader:book", true));
    advance(3);
    visibility(true);
    expect(result.current).toBe(3);
    advance(600);
    activity("scroll");
    expect(result.current).toBe(3);
    visibility(false);
    advance(7);
    expect(result.current).toBe(10);
  });

  it("keeps repeated scroll events in memory and writes storage only at checkpoints", () => {
    const persist = vi.spyOn(Storage.prototype, "setItem");
    const { result, unmount } = renderHook(() => useBookReadingTime("reader:book", true));
    for (let index = 0; index < 100; index += 1) {
      advance(0.05);
      activity("scroll");
    }
    expect(persist).not.toHaveBeenCalled();
    expect(result.current).toBe(0);
    advance(5);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(10);
    advance(2);
    activity("scroll");
    expect(persist).toHaveBeenCalledTimes(1);
    unmount();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(useReadingStatsStore.getState().seconds["reader:book"]).toBe(12);
  });

  it("stops on blur, does not count initially unfocused time and resumes on focus", () => {
    focused = false;
    const { result } = renderHook(() => useBookReadingTime("reader:book", true));
    advance(30);
    expect(result.current).toBe(0);
    focus(true);
    advance(4);
    focus(false);
    expect(result.current).toBe(4);
    advance(30);
    activity("keydown");
    expect(result.current).toBe(4);
    focus(true);
    advance(6);
    focus(false);
    expect(result.current).toBe(10);
  });

  it("does not lose elapsed time on a repeated focus event", () => {
    const { result } = renderHook(() => useBookReadingTime("reader:book", true));
    advance(4);
    focus(true);
    advance(6);
    expect(result.current).toBe(10);
  });

  it("stops after 120 seconds of inactivity and resumes from new activity without backfilling idle time", () => {
    const { result } = renderHook(() => useBookReadingTime("reader:book", true));
    advance(180);
    expect(result.current).toBe(120);
    activity("keydown");
    advance(10);
    expect(result.current).toBe(130);
    advance(50);
    activity("scroll");
    advance(110);
    expect(result.current).toBe(290);
    advance(60);
    expect(result.current).toBe(300);
  });

  it("checkpoints on unmount and removes every ongoing timer", () => {
    const { unmount } = renderHook(() => useBookReadingTime("reader:book", true));
    advance(7);
    unmount();
    expect(useReadingStatsStore.getState().seconds["reader:book"]).toBe(7);
    advance(100);
    activity();
    expect(useReadingStatsStore.getState().seconds["reader:book"]).toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pauses while reading is disabled and preserves partial checkpoints", () => {
    const { result, rerender } = renderHook(({ enabled }) => useBookReadingTime("reader:book", enabled), { initialProps: { enabled: true } });
    advance(3);
    rerender({ enabled: false });
    expect(result.current).toBe(3);
    advance(60);
    expect(result.current).toBe(3);
    rerender({ enabled: true });
    advance(10);
    expect(result.current).toBe(13);
  });

  it("keeps book and account totals separate when the active reader changes", () => {
    const { result, rerender } = renderHook(({ key }) => useBookReadingTime(key, true), { initialProps: { key: "alice:book-a" } });
    advance(4);
    rerender({ key: "alice:book-b" });
    expect(result.current).toBe(0);
    advance(6);
    rerender({ key: "bob:book-a" });
    expect(result.current).toBe(0);
    advance(3);
    rerender({ key: "alice:book-a" });
    expect(result.current).toBe(4);
    expect(useReadingStatsStore.getState().seconds).toEqual({ "alice:book-a": 4, "alice:book-b": 6, "bob:book-a": 3 });
  });
});
