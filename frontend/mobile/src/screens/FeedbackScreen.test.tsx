import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import { FeedbackScreen } from "./FeedbackScreen";
import type { FeedbackCorrection } from "../navigation/types";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  goBack: vi.fn(),
  params: {} as { screen?: string; correction?: FeedbackCorrection } | undefined,
  submitFeedback: vi.fn((): "sent" | "unavailable" | "invalid" => "sent"),
}));

vi.mock("@jojo/analytics/feedback", () => ({ submitFeedback: mocks.submitFeedback }));
vi.mock("../config/appVariant", () => ({ IS_EINK_RELEASE: false }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate, goBack: mocks.goBack }),
  useRoute: () => ({ params: mocks.params }),
}));
vi.mock("react-native", () => ({
  KeyboardAvoidingView: "div", Platform: { OS: "android", select: (values: { android: string }) => values.android },
  Pressable: "button", ScrollView: "section", StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: "span", TextInput: "textarea", View: "div",
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "section" }));
vi.mock("../components/ScreenHeader", () => ({ ScreenHeader: () => null }));

let view: ReactTestRenderer;
const button = (label: string) => view.root.findAllByType("button").find((node) => node.findAllByType("span").some((child) => child.props.children === label))!;
const spans = () => view.root.findAllByType("span").map((node) => node.props.children);

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.params = { screen: "settings" };
  await act(async () => { view = create(<FeedbackScreen />); });
});

it("shows topic choices and a disabled submit until the message has content", async () => {
  expect(spans()).toEqual(expect.arrayContaining(["功能异常", "功能建议", "其他"]));
  expect(button("提交反馈").props.disabled).toBe(true);

  await act(async () => view.root.findByType("textarea").props.onChangeText("翻页卡住"));
  expect(button("提交反馈").props.disabled).toBe(false);
});

it("submits a general report with the selected topic", async () => {
  await act(async () => view.root.findAllByType("button").find((node) => node.findAllByType("span").some((child) => child.props.children === "功能建议"))!.props.onPress());
  await act(async () => view.root.findByType("textarea").props.onChangeText("希望支持夜间模式"));
  await act(async () => button("提交反馈").props.onPress());

  expect(mocks.submitFeedback).toHaveBeenCalledWith({ topic: "suggestion", message: "希望支持夜间模式", screen: "settings" });
  expect(spans()).toContain("已提交，感谢你的反馈。");
});

it("quotes the selected content in correction mode", async () => {
  mocks.params = { screen: "book_reader", correction: { quote: "杰诺原油", contentType: "book", contentId: "ds:key", contentTitle: "德意志意识形态", section: "编辑说明" } };
  await act(async () => { view.update(<FeedbackScreen />); });

  expect(spans()).toContain("选中内容");
  const flat = spans().flat(Infinity).map(String).join("");
  expect(flat).toContain("杰诺原油");
  expect(flat).toContain("——《德意志意识形态》 · 编辑说明");
  expect(spans()).not.toContain("功能异常");

  await act(async () => view.root.findByType("textarea").props.onChangeText("应为「杰努原油」"));
  await act(async () => button("提交反馈").props.onPress());

  expect(mocks.submitFeedback).toHaveBeenCalledWith({
    topic: "content_correction", message: "应为「杰努原油」", quote: "杰诺原油",
    contentType: "book", contentId: "ds:key", contentTitle: "德意志意识形态", section: "编辑说明", screen: "book_reader",
  });
});

it("surfaces the unavailable notice instead of failing silently", async () => {
  mocks.submitFeedback.mockReturnValueOnce("unavailable");
  await act(async () => view.root.findByType("textarea").props.onChangeText("测试"));
  await act(async () => button("提交反馈").props.onPress());

  expect(spans()).toContain("使用统计未开启或尚未就绪，暂时无法提交反馈。");
  expect(mocks.goBack).not.toHaveBeenCalled();
});
