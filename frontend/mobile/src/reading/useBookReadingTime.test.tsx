import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBookReadingTime } from "./useBookReadingTime";

const mocks = vi.hoisted(() => ({
  focused: true, add: vi.fn(), change: undefined as ((state: string) => void) | undefined,
}));
vi.mock("react-native", () => ({ AppState: { currentState: "active", addEventListener: (_: string, listener: (state: string) => void) => {
  mocks.change = listener; return { remove() {} };
} } }));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => mocks.focused }));
vi.mock("../account/auth", () => ({ useMobileAuthStore: (select: (state: unknown) => unknown) => select({ user: { id: "reader" } }) }));
vi.mock("../store/mobileStore", () => ({ useMobileStore: (select: (state: unknown) => unknown) => select({ bookReadingSeconds: {}, addBookReadingSeconds: mocks.add }) }));

let state: ReturnType<typeof useBookReadingTime>;
let view: ReactTestRenderer | undefined;
function Harness({ enabled = true }: { enabled?: boolean }) { state = useBookReadingTime("dataset", "book", enabled); return null; }
const secondsSaved = () => mocks.add.mock.calls.reduce((total, [, seconds]) => total + Number(seconds), 0);

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers(); vi.clearAllMocks(); mocks.focused = true;
});
afterEach(async () => { await act(async () => view?.unmount()); view = undefined; vi.useRealTimers(); });

describe("book reading time", () => {
  it("stops after two minutes without activity and resumes without counting idle time", async () => {
    await act(async () => { view = create(<Harness />); });
    vi.advanceTimersByTime(300_000);
    expect(secondsSaved()).toBe(120);
    vi.advanceTimersByTime(7_000);
    state.recordActivity();
    vi.advanceTimersByTime(8_000);
    expect(secondsSaved()).toBe(128);
    expect(mocks.add).toHaveBeenLastCalledWith(JSON.stringify(["reader", "dataset", "book"]), 8);
  });

  it("checkpoints when a tool opens and excludes background time", async () => {
    await act(async () => { view = create(<Harness />); });
    vi.advanceTimersByTime(5000);
    mocks.change!("background");
    expect(secondsSaved()).toBe(5);
    vi.advanceTimersByTime(60_000);
    expect(secondsSaved()).toBe(5);
    mocks.change!("active");
    vi.advanceTimersByTime(4000);
    await act(async () => view!.update(<Harness enabled={false} />));
    expect(secondsSaved()).toBe(9);
    vi.advanceTimersByTime(60_000);
    expect(secondsSaved()).toBe(9);
  });

  it("does not count an unfocused reader", async () => {
    mocks.focused = false;
    await act(async () => { view = create(<Harness />); });
    vi.advanceTimersByTime(60_000);
    expect(mocks.add).not.toHaveBeenCalled();
  });
});
