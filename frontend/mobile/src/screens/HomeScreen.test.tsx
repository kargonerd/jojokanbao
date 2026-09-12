import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeScreen } from "./HomeScreen";

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), eInk: false, loadBooks: vi.fn(), loadCover: vi.fn(), dismissKeyboard: vi.fn() }));
vi.mock("react-native", () => ({ Image: "img", Pressable: "button", ScrollView: "section", Text: "span", TextInput: "input", View: "div",
  Keyboard: { dismiss: mocks.dismissKeyboard },
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
  Platform: { select: (values: { android: string }) => values.android },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFillObject: {} } }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "i" }));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return { useNavigation: () => ({ navigate: mocks.navigate }), useFocusEffect: (callback: () => () => void) => useEffect(callback, [callback]) };
});
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "main" }));
vi.mock("../config/appVariant", () => ({ get IS_EINK_RELEASE() { return mocks.eInk; } }));
vi.mock("../components/PeriodicalCoverCard", () => ({ publicationImages: {} }));
vi.mock("../components/ScreenHeader", () => ({ ScreenHeader: "header" }));
vi.mock("../lib/books", () => ({ loadMobileBooks: mocks.loadBooks, loadMobileBookCover: mocks.loadCover, cachedMobileBookCover: () => "", fuzzyBookTitleScore: () => 0 }));
vi.mock("../lib/haptics", () => ({ impactHaptic: vi.fn() }));
vi.mock("../store/mobileStore", () => ({ useMobileStore: (select: (state: unknown) => unknown) => select({ hapticsEnabled: false,
  recentBooks: [{ datasetId: "book", itemKey: "full", title: "测试书", progress: 1, updatedAt: 1 }], recentIssues: [] }) }));
let view: ReactTestRenderer;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.loadBooks.mockReset().mockResolvedValue([]);
  mocks.loadCover.mockReset().mockResolvedValue("data:image/png;base64,AQID");
  mocks.navigate.mockClear();
  mocks.dismissKeyboard.mockClear();
});
afterEach(async () => { await act(async () => view?.unmount()); vi.useRealTimers(); });
describe.each([false, true])("home bookshelf (eInk=%s)", (eInk) => {
  it("keeps title selection explicit and closes suggestions when touching outside", async () => {
    mocks.loadBooks.mockResolvedValue([{ datasetId: "mao", type: "book-series", title: "毛泽东文集", indexObject: "mao.jox" }]);
    await act(async () => { view = create(<HomeScreen />); });
    const input = view.root.findByType("input");
    const matches = () => view.root.findAllByType("span").filter((node) => node.props.children === "毛泽东文集");
    await act(async () => input.props.onChangeText("毛文集"));
    expect(matches()).toHaveLength(1);
    expect(view.root.findAllByType("button").some((node) => node.props.accessibilityLabel === "搜索")).toBe(false);
    await act(async () => input.props.onSubmitEditing());
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.dismissKeyboard).toHaveBeenCalled();
    expect(matches()).toHaveLength(1);
    await act(async () => view.root.findByType("main").props.onTouchStart());
    expect(matches()).toHaveLength(0);
    expect(input.props.value).toBe("毛文集");
    await act(async () => input.props.onFocus());
    expect(matches()).toHaveLength(1);
    await act(async () => view.root.findByType("section").props.onScrollBeginDrag());
    expect(matches()).toHaveLength(0);
  });

  it("opens Bookshelf, not Library", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    mocks.eInk = eInk; mocks.navigate.mockClear();
    await act(async () => { view = create(<HomeScreen />); });
    const button = view.root.findAllByType("button").find((node) => node.findAllByType("span").some((text) => text.props.children === "我的书架"));
    expect(button).toBeTruthy();
    await act(async () => button!.props.onPress());
    expect(mocks.navigate).toHaveBeenCalledWith("Bookshelf");
    expect(mocks.navigate).not.toHaveBeenCalledWith("Library");
  });

  it("recovers the catalog and recent cover after an offline launch without remounting", async () => {
    vi.useFakeTimers();
    const book = { datasetId: "book", type: "book", title: "测试书", indexObject: "index.jox" };
    mocks.loadBooks.mockRejectedValueOnce(new Error("offline")).mockResolvedValue([book]);
    await act(async () => { view = create(<HomeScreen />); });
    expect(view.root.findByType("img").props.source.uri).toBe("data:image/png;base64,AQID");
    expect(mocks.loadCover).toHaveBeenCalledWith("book", "full");
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(mocks.loadBooks).toHaveBeenCalledTimes(2);
    expect(view.root.findByType("img").props.source.uri).toBe("data:image/png;base64,AQID");
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(mocks.loadBooks).toHaveBeenCalledTimes(2);
  });

  it("retries a failed cover independently of a stalled catalog", async () => {
    vi.useFakeTimers();
    mocks.loadBooks.mockReturnValue(new Promise(() => undefined));
    mocks.loadCover.mockRejectedValueOnce(new Error("offline"));
    await act(async () => { view = create(<HomeScreen />); });
    expect(view.root.findAllByType("img")).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(view.root.findByType("img").props.source.uri).toBe("data:image/png;base64,AQID");
    expect(mocks.loadCover).toHaveBeenCalledTimes(2);
  });
});
