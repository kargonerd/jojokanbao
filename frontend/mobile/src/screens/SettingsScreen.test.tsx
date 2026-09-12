import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FEEDBACK_QQ_GROUP } from "@jojo/content";
import { SettingsScreen } from "./SettingsScreen";

const mocks = vi.hoisted(() => ({
  copy: vi.fn(), openURL: vi.fn(), navigate: vi.fn(),
}));
vi.mock("react-native", () => ({
  ActivityIndicator: "progress", Pressable: "button", Text: "span", View: "div", ScrollView: "main", Switch: "input",
  Alert: { alert: vi.fn() }, Linking: { openURL: mocks.openURL },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: "android", select: (values: { android: string }) => values.android },
}));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "i" }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: mocks.navigate, goBack: vi.fn() }), useRoute: () => ({ params: { section: "about" } }) }));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "section" }));
vi.mock("expo-application", () => ({ nativeApplicationVersion: "0.0.3", applicationId: "com.luoxixi.jojokanbao" }));
vi.mock("expo-clipboard", () => ({ setStringAsync: mocks.copy }));
vi.mock("../components/ScreenHeader", () => ({ ScreenHeader: () => null }));
vi.mock("../lib/appUpdate", () => ({ checkNativeAppUpdate: vi.fn(), openNativeAppUpdate: vi.fn() }));
vi.mock("../lib/haptics", () => ({ selectionHaptic: vi.fn(), toggleHaptic: vi.fn() }));
vi.mock("../lib/times", () => ({ mobileTimesApi: {}, timesSourceName: vi.fn() }));
vi.mock("../store/mobileStore", () => ({ useMobileStore: (select: (state: unknown) => unknown) => select({ timesDisabledSourceIds: [], recentIssues: [], recentBooks: [] }) }));

let view: ReactTestRenderer;
const button = (label: string) => view.root.findAllByType("button").find((node) => node.findAllByType("span").some((child) => child.props.children === label))!;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.copy.mockResolvedValue(undefined);
  mocks.openURL.mockResolvedValue(undefined);
  await act(async () => { view = create(<SettingsScreen />); });
});
afterEach(async () => { await act(async () => view.unmount()); });

it("copies the displayed shared group without nesting support in about", async () => {
  const shown = view.root.findAllByType("span").find((node) => node.props.selectable && node.props.children?.includes?.(FEEDBACK_QQ_GROUP));
  expect(shown).toBeDefined();
  await act(async () => button("复制群号").props.onPress());
  expect(mocks.copy).toHaveBeenLastCalledWith(FEEDBACK_QQ_GROUP);
  expect(button("支持 JOJO 看报")).toBeUndefined();
});

it("keeps manual copy and Bilibili feedback available if clipboard copying fails", async () => {
  mocks.copy.mockRejectedValueOnce(new Error("Clipboard unavailable"));
  await act(async () => button("复制群号").props.onPress());
  expect(view.root.findAllByType("span").some((node) => node.props.children === "复制失败，可长按群号手动复制。")).toBe(true);
  await act(async () => button("在 B 站留言或私信").props.onPress());
  expect(mocks.openURL).toHaveBeenCalledExactlyOnceWith("https://space.bilibili.com/571556400");
  expect(view.root.findAllByType("span").some((node) => String(node.props.children).includes("未经原权利人许可"))).toBe(true);
});
