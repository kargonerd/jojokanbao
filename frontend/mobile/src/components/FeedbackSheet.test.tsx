import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FeedbackSheet } from "./FeedbackSheet";
import { mobileTheme } from "../theme/tokens";

const feedbackApi = vi.hoisted(() => ({ submitFeedback: vi.fn(() => "sent" as const) }));
vi.mock("@jojo/analytics/feedback", () => feedbackApi);
vi.mock("react-native", () => ({
  Modal: "dialog", TextInput: "textarea", Pressable: "button", Text: "span", View: "div", ScrollView: "scroll",
  KeyboardAvoidingView: "div",
  Animated: {
    Value: class { setValue() {} interpolate() { return 0; } },
    timing: () => ({ start: (callback?: () => void) => callback?.() }),
    View: "div",
  },
  Easing: { out: (value: unknown) => value, in: (value: unknown) => value, cubic: {} },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {} },
  Platform: { OS: "android", select: (values: { android: string }) => values.android },
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "section" }));
vi.mock("expo-application", () => ({ applicationId: "com.luoxixi.jojokanbao", nativeApplicationVersion: "0.0.3" }));

let view: ReactTestRenderer;
const text = (vue: ReactTestRenderer) => vue.root.findAllByType("span").map((node) => node.props.children).flat().join("|");
const press = async (label: string, vue: ReactTestRenderer = view) => {
  const target = vue.root.findAllByType("button").find((node) => node.findAllByType("span").some((child) => child.props.children === label));
  await act(async () => target!.props.onPress());
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
});
afterEach(async () => { if (view) await act(async () => view.unmount()); });

it("submits a free report with the selected topic", async () => {
  await act(async () => { view = create(<FeedbackSheet visible screen="settings" onClose={vi.fn()} theme={mobileTheme} />); });
  expect(view.root.findByType("dialog").props.visible).toBe(true);
  await act(async () => view.root.findByType("textarea").props.onChangeText("书架排序错乱"));
  await press("功能建议");
  await press("提交");
  expect(feedbackApi.submitFeedback).toHaveBeenCalledWith({ topic: "suggestion", message: "书架排序错乱", screen: "settings" });
  expect(text(view)).toContain("已提交，感谢你的反馈。");
});

it("quotes the selected passage in correction mode and keeps the submit button gated", async () => {
  const onClose = vi.fn();
  await act(async () => { view = create(<FeedbackSheet visible screen="book_reader" correction={{ quote: "今日耍闻", contentType: "book", contentId: "set:item", contentTitle: "书名" }} onClose={onClose} theme={mobileTheme} />); });
  expect(text(view)).toContain("今日耍闻");
  expect(text(view)).not.toContain("功能建议");
  const submit = view.root.findAllByType("button").find((node) => node.findAllByType("span").some((child) => child.props.children === "提交"))!;
  expect(submit.props.disabled).toBe(true);

  await act(async () => view.root.findByType("textarea").props.onChangeText("应为「今日要闻」"));
  await press("提交");
  expect(feedbackApi.submitFeedback).toHaveBeenCalledWith({
    topic: "content_correction", message: "应为「今日要闻」", quote: "今日耍闻", contentType: "book",
    contentId: "set:item", contentTitle: "书名", screen: "book_reader",
  });
});

it("explains when the analytics channel cannot deliver", async () => {
  feedbackApi.submitFeedback.mockReturnValueOnce("unavailable" as never);
  await act(async () => { view = create(<FeedbackSheet visible onClose={vi.fn()} theme={mobileTheme} />); });
  await act(async () => view.root.findByType("textarea").props.onChangeText("任意问题"));
  await press("提交");
  expect(text(view)).toContain("使用统计未开启或尚未就绪，暂时无法提交反馈。");
  expect(view.root.findByType("dialog").props.visible).toBe(true);
});
