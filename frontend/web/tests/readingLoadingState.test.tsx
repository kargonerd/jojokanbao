import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadingLoadingState } from "../src/reading/ReadingLoadingState";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("reading loading quotes", () => {
  it("keeps progress visible immediately and reveals the quote after a short wait", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    render(<ReadingLoadingState kind="times" status="正在加载新闻…" />);

    expect(screen.getByText("正在加载新闻…")).toBeTruthy();
    expect(screen.queryByText(/你们要关心国家大事/u)).toBeNull();

    act(() => vi.advanceTimersByTime(650));

    expect(screen.getByText(/你们要关心国家大事/u)).toBeTruthy();
    expect(screen.getByText(/一九六六年八月十日/u)).toBeTruthy();
  });

  it("selects from the relevant pool once when a loading state starts", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const { rerender } = render(<ReadingLoadingState kind="book" status="正在打开书籍" delayMs={0} />);

    expect(screen.getByText(/虚心使人进步/u)).toBeTruthy();
    rerender(<ReadingLoadingState kind="book" status="正在读取章节" delayMs={0} />);
    expect(screen.getByText(/虚心使人进步/u)).toBeTruthy();
  });
});
