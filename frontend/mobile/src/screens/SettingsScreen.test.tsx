import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FEEDBACK_QQ_GROUP } from "@jojo/content";
import { SettingsScreen } from "./SettingsScreen";

const mocks = vi.hoisted(() => ({
  copy: vi.fn(), openURL: vi.fn(), navigate: vi.fn(),
  config: {qqGroup: "974380749"},
}));
vi.mock("react-native", () => ({
  ActivityIndicator: "progress", Pressable: "button", Text: "span", View: "div", ScrollView: "main", Switch: "input",
  Modal: "dialog", TextInput: "textarea", KeyboardAvoidingView: "div",
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
vi.mock("../components/AppVersionInfo", () => ({ AppVersionInfo: () => null }));
vi.mock("../lib/appUpdate", () => ({ checkNativeAppUpdate: vi.fn(), openNativeAppUpdate: vi.fn() }));
vi.mock("../lib/haptics", () => ({ selectionHaptic: vi.fn(), toggleHaptic: vi.fn() }));
vi.mock("../lib/times", () => ({ mobileTimesApi: {}, timesSourceName: vi.fn() }));
vi.mock("../store/mobileStore", () => ({ useMobileStore: (select: (state: unknown) => unknown) => select({ timesDisabledSourceIds: [], recentIssues: [], recentBooks: [] }) }));
vi.mock("../config/supportConfig", () => ({useSupportConfig: () => mocks.config}));
const feedbackApi = vi.hoisted(() => ({ submitFeedback: vi.fn(() => "sent" as const) }));
vi.mock("@jojo/analytics/feedback", () => feedbackApi);

let view: ReactTestRenderer;
const button = (label: string) => view.root.findAllByType("button").find((node) => node.findAllByType("span").some((child) => child.props.children === label))!;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.config.qqGroup = FEEDBACK_QQ_GROUP;
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
  const copyNotice = "群号已复制，可在 QQ 中搜索并申请加入。";
  expect(button("复制群号").parent!.parent!.findAllByType("span").some((node) => node.props.children === copyNotice)).toBe(true);
  expect(button("在 B 站留言或私信").parent!.findAllByType("span").some((node) => node.props.children === copyNotice)).toBe(false);
  expect(button("支持我们")).toBeUndefined();
  expect(button("在浏览器打开 JOJO 看报")).toBeUndefined();
});

it("keeps manual copy and Bilibili feedback available if clipboard copying fails", async () => {
  mocks.copy.mockRejectedValueOnce(new Error("Clipboard unavailable"));
  await act(async () => button("复制群号").props.onPress());
  expect(view.root.findAllByType("span").some((node) => node.props.children === "复制失败，可长按群号手动复制。")).toBe(true);
  await act(async () => button("在 B 站留言或私信").props.onPress());
  expect(mocks.openURL).toHaveBeenCalledExactlyOnceWith("https://space.bilibili.com/571556400");
  expect(view.root.findAllByType("span").some((node) => String(node.props.children).includes("未经原权利人许可"))).toBe(true);
});

it("keeps copy and Bilibili results beside their own actions when both finish asynchronously", async () => {
  let finishCopy!: () => void;
  mocks.copy.mockImplementationOnce(() => new Promise<void>((resolve) => { finishCopy = resolve; }));
  mocks.openURL.mockRejectedValueOnce(new Error("Bilibili unavailable"));
  await act(async () => button("复制群号").props.onPress());
  await act(async () => button("在 B 站留言或私信").props.onPress());
  await act(async () => finishCopy());

  const groupSection = button("复制群号").parent!.parent!;
  const bilibiliSection = button("在 B 站留言或私信").parent!;
  const copyNotice = "群号已复制，可在 QQ 中搜索并申请加入。";
  const linkNotice = "无法打开 B 站，请稍后重试，或在 B 站搜索 JOJO看报。";
  expect(groupSection.findAllByType("span").some((node) => node.props.children === copyNotice)).toBe(true);
  expect(groupSection.findAllByType("span").some((node) => node.props.children === linkNotice)).toBe(false);
  expect(bilibiliSection.findAllByType("span").some((node) => node.props.children === linkNotice)).toBe(true);
  expect(bilibiliSection.findAllByType("span").some((node) => node.props.children === copyNotice)).toBe(false);

  await act(async () => button("在 B 站留言或私信").props.onPress());
  expect(bilibiliSection.findAllByType("span").some((node) => node.props.children === linkNotice)).toBe(false);
  expect(groupSection.findAllByType("span").some((node) => node.props.children === copyNotice)).toBe(true);
});

it("copies the new remote group shown on screen after a configuration update", async () => {
  mocks.config.qqGroup = "123456789";
  await act(async () => { view.update(<SettingsScreen />); });
  expect(view.root.findAllByType("span").some(node => node.props.selectable && node.props.children?.includes?.("123456789"))).toBe(true);
  await act(async () => button("复制群号").props.onPress());
  expect(mocks.copy).toHaveBeenLastCalledWith("123456789");
});

it("opens the in-app feedback form and submits a report from settings", async () => {
  const sheet = view.root.findByType("dialog");
  expect(sheet.props.visible).toBe(false);
  await act(async () => button("问题反馈").props.onPress());
  expect(view.root.findByType("dialog").props.visible).toBe(true);

  await act(async () => view.root.findByType("textarea").props.onChangeText("笔记无法保存"));
  await act(async () => button("提交").props.onPress());
  expect(feedbackApi.submitFeedback).toHaveBeenCalledWith({ topic: "bug", message: "笔记无法保存", screen: "settings" });
});
