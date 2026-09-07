import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReadingProgress } from "./useReadingProgress";

const mocks = vi.hoisted(() => ({
  save: vi.fn(), remove: vi.fn(),
  blur: undefined as (() => void) | undefined,
  appState: undefined as ((state: string) => void) | undefined,
}));
vi.mock("react-native", () => ({ AppState: {
  addEventListener: (_: string, listener: (state: string) => void) => {
    mocks.appState = listener;
    return { remove: mocks.remove };
  },
} }));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return { useFocusEffect: (callback: () => () => void) => useEffect(() => {
    mocks.blur = callback();
    return mocks.blur;
  }, [callback]) };
});
type Progress = { chapter: string; page: number };
let state: ReturnType<typeof useReadingProgress<Progress>>;
function Harness() { state = useReadingProgress<Progress>(mocks.save); return null; }
let view: ReactTestRenderer | undefined;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers(); vi.clearAllMocks();
  await act(async () => { view = create(<Harness />); });
});
afterEach(async () => {
  await act(async () => view?.unmount());
  vi.useRealTimers();
});

describe("reading progress checkpoints", () => {
  it("saves only the latest position from a burst of page turns", () => {
    for (let page = 1; page <= 20; page++) state.schedule({ chapter: "one", page });
    expect(mocks.save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(650);
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith({ chapter: "one", page: 20 });
  });

  it("keeps checkpointing during continuous scrolling", () => {
    for (let page = 1; page <= 20; page++) {
      state.schedule({ chapter: "one", page });
      vi.advanceTimersByTime(100);
    }
    expect(mocks.save.mock.calls).toEqual([[{ chapter: "one", page: 7 }], [{ chapter: "one", page: 14 }]]);
    state.flush();
    expect(mocks.save).toHaveBeenLastCalledWith({ chapter: "one", page: 20 });
  });

  it.each(["blur", "background", "inactive", "unmount"])("preserves a just-turned page on %s", async (event) => {
    state.schedule({ chapter: "two", page: 3 });
    await act(async () => {
      if (event === "blur") mocks.blur!();
      else if (event === "unmount") { view!.unmount(); view = undefined; }
      else mocks.appState!(event);
    });
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith({ chapter: "two", page: 3 });
    vi.advanceTimersByTime(2000);
    expect(mocks.save).toHaveBeenCalledOnce();
  });

  it("flushes the previous chapter before scheduling the next one without duplicate writes", () => {
    state.schedule({ chapter: "one", page: 5 });
    state.flush(); state.flush();
    state.schedule({ chapter: "two", page: 1 });
    vi.advanceTimersByTime(650);
    expect(mocks.save.mock.calls).toEqual([[{ chapter: "one", page: 5 }], [{ chapter: "two", page: 1 }]]);
  });
});
