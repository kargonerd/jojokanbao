import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileBook, MobileBookOpenTarget } from "./books";
import { useOpenBook } from "./useOpenBook";

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), resolve: vi.fn(), blur: undefined as (() => void) | undefined }));
vi.mock("./books", () => ({ resolveMobileBookOpenTarget: mocks.resolve }));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return {
    useNavigation: () => ({ navigate: mocks.navigate }),
    useFocusEffect: (callback: () => () => void) => useEffect(() => {
      mocks.blur = callback();
      return mocks.blur;
    }, [callback]),
  };
});

const first: MobileBook = { datasetId: "one", title: "第一本", type: "book", indexObject: "one.jox" };
const second: MobileBook = { ...first, datasetId: "two", title: "第二本" };
const target = (book: MobileBook): MobileBookOpenTarget => ({ screen: "BookReader", datasetId: book.datasetId, itemKey: "full", title: book.title, bookTitle: book.title });
function deferred() {
  let resolve!: (target: MobileBookOpenTarget) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<MobileBookOpenTarget>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
let state: ReturnType<typeof useOpenBook>;
function Harness() { state = useOpenBook(); return null; }
let view: ReactTestRenderer;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  await act(async () => { view = create(<Harness />); });
});
afterEach(async () => { await act(async () => view.unmount()); });

describe("opening books on slow connections", () => {
  it("shows the pending title immediately and coalesces repeated taps", async () => {
    const pending = deferred();
    mocks.resolve.mockReturnValueOnce(pending.promise);
    await act(async () => { void state.openBook(first); void state.openBook(first); });
    expect(state.openingBook).toBe(first);
    expect(mocks.resolve).toHaveBeenCalledOnce();
    expect(mocks.navigate).not.toHaveBeenCalled();
    await act(async () => pending.resolve(target(first)));
    expect(state.openingBook).toBeUndefined();
    expect(mocks.navigate).toHaveBeenCalledOnce();
    expect(mocks.navigate).toHaveBeenCalledWith("BookReader", expect.objectContaining({ datasetId: "one", itemKey: "full" }));
  });

  it("honors the latest book choice even if an earlier request finishes later", async () => {
    const older = deferred(); const newer = deferred();
    mocks.resolve.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    await act(async () => { void state.openBook(first); void state.openBook(second); });
    await act(async () => newer.resolve(target(second)));
    await act(async () => older.resolve(target(first)));
    expect(mocks.navigate).toHaveBeenCalledOnce();
    expect(mocks.navigate).toHaveBeenCalledWith("BookReader", expect.objectContaining({ datasetId: "two" }));
  });

  it.each(["resolve", "reject"] as const)("ignores a late %s after leaving the screen", async (outcome) => {
    const pending = deferred();
    mocks.resolve.mockReturnValueOnce(pending.promise);
    await act(async () => { void state.openBook(first); });
    await act(async () => mocks.blur!());
    await act(async () => outcome === "resolve" ? pending.resolve(target(first)) : pending.reject(new Error("offline")));
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(state.openingBook).toBeUndefined();
  });

  it("opens the volume page after a directory failure and clears pending feedback", async () => {
    mocks.resolve.mockRejectedValueOnce(new Error("offline"));
    await act(async () => { await state.openBook(first); });
    expect(mocks.navigate).toHaveBeenCalledWith("BookDetails", { book: first });
    expect(state.openingBook).toBeUndefined();
  });
});
