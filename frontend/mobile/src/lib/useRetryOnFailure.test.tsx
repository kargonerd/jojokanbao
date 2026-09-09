import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRetryOnFailure } from "./useRetryOnFailure";

const mocks = vi.hoisted(() => ({
  state: "active", focused: true,
  listener: undefined as ((state: string) => void) | undefined,
  remove: vi.fn(),
}));
vi.mock("react-native", () => ({ AppState: {
  get currentState() { return mocks.state; },
  addEventListener: (_event: string, listener: (state: string) => void) => {
    mocks.listener = listener;
    return { remove: mocks.remove };
  },
} }));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return { useFocusEffect: (callback: () => (() => void) | undefined) => {
    const focused = mocks.focused;
    useEffect(() => focused ? callback() : undefined, [callback, focused]);
  } };
});
function Probe({ failed, retry }: { failed: boolean; retry: () => void }) {
  useRetryOnFailure(failed, retry);
  return null;
}
let view: ReactTestRenderer;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers(); mocks.state = "active"; mocks.focused = true; mocks.remove.mockClear();
});
afterEach(async () => { await act(async () => view?.unmount()); vi.useRealTimers(); });

describe("failed content recovery", () => {
  it("retries in the foreground and stops after success", async () => {
    const retry = vi.fn();
    await act(async () => { view = create(<Probe failed retry={retry} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(retry).toHaveBeenCalledOnce();
    mocks.state = "background";
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(retry).toHaveBeenCalledOnce();
    mocks.state = "active";
    await act(async () => mocks.listener?.("active"));
    expect(retry).toHaveBeenCalledTimes(2);
    await act(async () => view.update(<Probe failed={false} retry={retry} />));
    expect(mocks.remove).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("uses the current retry callback and suspends while another screen is open", async () => {
    const oldRetry = vi.fn(); const retry = vi.fn();
    await act(async () => { view = create(<Probe failed retry={oldRetry} />); });
    await act(async () => view.update(<Probe failed retry={retry} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(oldRetry).not.toHaveBeenCalled(); expect(retry).toHaveBeenCalledOnce();
    mocks.focused = false;
    await act(async () => view.update(<Probe failed retry={retry} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(retry).toHaveBeenCalledOnce();
    mocks.focused = true;
    await act(async () => view.update(<Probe failed retry={retry} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(retry).toHaveBeenCalledTimes(2);
  });
});
