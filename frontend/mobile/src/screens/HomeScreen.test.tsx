import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeScreen } from "./HomeScreen";

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), eInk: false }));
vi.mock("react-native", () => ({ Image: "img", Pressable: "button", ScrollView: "section", Text: "span", TextInput: "input", View: "div",
  Platform: { select: (values: { android: string }) => values.android },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFillObject: {} } }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "i" }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: mocks.navigate }) }));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "main" }));
vi.mock("../config/appVariant", () => ({ get IS_EINK_RELEASE() { return mocks.eInk; } }));
vi.mock("../components/PeriodicalCoverCard", () => ({ publicationImages: {} }));
vi.mock("../components/ScreenHeader", () => ({ ScreenHeader: "header" }));
vi.mock("../lib/books", () => ({ loadMobileBooks: async () => [] }));
vi.mock("../lib/haptics", () => ({ impactHaptic: vi.fn() }));
vi.mock("../store/mobileStore", () => ({ useMobileStore: (select: (state: unknown) => unknown) => select({ hapticsEnabled: false,
  recentBooks: [{ datasetId: "book", itemKey: "full", title: "测试书", progress: 1, updatedAt: 1 }], recentIssues: [] }) }));
let view: ReactTestRenderer;
afterEach(async () => { await act(async () => view?.unmount()); });
describe.each([false, true])("home bookshelf (eInk=%s)", (eInk) => {
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
});
