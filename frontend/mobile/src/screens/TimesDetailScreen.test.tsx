import { type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimesDetailScreen } from "./TimesDetailScreen";
import { ReaderSelectionToolbar } from "../components/ReaderSelectionToolbar";
import type { explainMobileTimesSelection } from "../lib/timesAgent";

const mocks = vi.hoisted(() => ({ getNews: vi.fn(), explain: vi.fn(), cancel: vi.fn(), inject: vi.fn(), copy: vi.fn(), eink: false }));
vi.mock("react-native", () => ({ ActivityIndicator: "progress", Pressable: "button", Text: "span", TextInput: "textarea", KeyboardAvoidingView: "keyboard-avoid", View: "div", ScrollView: "section",
  Modal: ({ visible, children }: { visible: boolean; children: ReactNode }) => visible ? children : null,
  Linking: { openURL: vi.fn() }, StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  Platform: { OS: "android", select: (value: { android: string }) => value.android } }));
vi.mock("react-native-webview", async () => {
  const { forwardRef, useImperativeHandle, createElement } = await import("react");
  return { WebView: forwardRef((props: Record<string, unknown>, ref) => {
    useImperativeHandle(ref, () => ({ injectJavaScript: mocks.inject }));
    return createElement("webview", props);
  }) };
});
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "i" }));
vi.mock("expo-clipboard", () => ({ setStringAsync: mocks.copy }));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "main" }));
vi.mock("../components/ScreenHeader", () => ({ ScreenHeader: "header" }));
vi.mock("../reading/SpeechPlayer", () => ({ NativeSpeechPlayer: () => null }));
vi.mock("../reading/speech", () => ({ mobileSpeechSegments: vi.fn(() => []) }));
vi.mock("../lib/sourceLogos", () => ({ SOURCE_LOGOS: {} }));
vi.mock("../lib/useRetryOnFailure", () => ({ useRetryOnFailure: () => undefined }));
vi.mock("../store/mobileStore", () => ({ useMobileStore: (select: (state: unknown) => unknown) => select({ timesLanguage: "zh-CN" }) }));
vi.mock("../config/appVariant", () => ({ get IS_EINK_RELEASE() { return mocks.eink; } }));
vi.mock("../lib/timesAgent", () => ({ explainMobileTimesSelection: mocks.explain }));
vi.mock("../lib/times", () => ({ mobileTimesApi: { getNews: mocks.getNews }, leadTimesImage: () => undefined,
  timesSourceName: () => "Reuters", safeTimesExternalUrl: () => null, exactTimesArticleTime: () => "2026年9月10日" }));

let view: ReactTestRenderer;
const article = { id: "news", title: "新闻标题", content: "<p>杰诺原油的价格上涨。</p>", contentFormat: "html", translationAvailable: true,
  usingTranslation: true, source: { id: "reuters" }, assets: [{ id: "lead", type: "image", caption: "English caption" }], assetUrls: { lead: "data:image/jpeg;base64,abc" } };
const selection = { type: "selection", quote: "杰诺原油", prefix: "前文", suffix: "后文", rect: { left: 170, right: 250, top: 240, bottom: 260 }, viewport: { width: 390, height: 700 } };
async function message(payload: unknown) {
  await act(async () => view.root.findByType("webview").props.onMessage({ nativeEvent: { data: JSON.stringify(payload) } }));
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.getNews.mockResolvedValue(article);
  mocks.explain.mockReturnValue(mocks.cancel);
  await act(async () => { view = create(<TimesDetailScreen route={{ params: { issueDate: "20260910", newsId: "news" } } as never} navigation={{ goBack: vi.fn() } as never} />); });
  await act(async () => view.root.findAllByType("div").find((node) => node.props.onLayout)!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 100, width: 390, height: 700 } } }));
});
afterEach(async () => { await act(async () => view.unmount()); });

describe("Times reading interactions", () => {
  it("anchors the shared toolbar above the selection and clears it after copying", async () => {
    await message(selection);
    const toolbar = view.root.findByType(ReaderSelectionToolbar);
    const position = toolbar.findAllByType("div")[0]!.props.style[1];
    expect(position).toMatchObject({ width: 144, top: 262, left: 138 });
    await act(async () => view.root.findByProps({ accessibilityLabel: "复制" }).props.onPress());
    expect(mocks.copy).toHaveBeenCalledWith("杰诺原油");
    expect(mocks.inject).toHaveBeenCalledWith(expect.stringContaining("removeAllRanges"));
    expect(view.root.findAllByType(ReaderSelectionToolbar)).toHaveLength(0);
  });

  it.each([false, true])("shows generation progress, supports retry and cancels on close (eInk=%s)", async (eink) => {
    mocks.eink = eink;
    await message(selection);
    await act(async () => view.root.findByProps({ accessibilityLabel: "AI 解释" }).props.onPress());
    const callbacks = mocks.explain.mock.calls[0]![2] as Parameters<typeof explainMobileTimesSelection>[2];
    expect(view.root.findAllByType("progress")).toHaveLength(eink ? 0 : 1);
    expect(view.root.findByProps({ accessibilityRole: "progressbar" })).toBeTruthy();
    await act(async () => callbacks.onError("连接失败"));
    expect(view.root.findAllByType("progress")).toHaveLength(0);
    const retry = view.root.findAllByType("button").find((node) => node.findAllByType("span").some((text) => text.props.children === "重新解释"))!;
    await act(async () => retry.props.onPress());
    expect(mocks.explain).toHaveBeenCalledTimes(2);
    expect(mocks.explain.mock.calls[1]![1]).toMatchObject({ quote: "杰诺原油" });
    await act(async () => view.root.findByProps({ accessibilityLabel: "关闭" }).props.onPress());
    expect(mocks.cancel).toHaveBeenCalled();
    expect(view.root.findAllByProps({ accessibilityRole: "progressbar" })).toHaveLength(0);
    mocks.eink = false;
  });

  it("opens the archived image and translated caption in a zoomable preview", async () => {
    await message({ type: "image", assetId: "lead", caption: "中文图注" });
    const preview = view.root.findAllByType("webview").find((node) => node.props.javaScriptEnabled === false)!;
    expect(preview.props.source.html).toContain("data:image/jpeg;base64,abc");
    expect(preview.props.source.html).toContain("maximum-scale=5");
    expect(preview.props.source.html).not.toContain("English caption");
    await act(async () => view.root.findByProps({ title: "图片预览" }).props.onBack());
    expect(view.root.findAllByType("webview")).toHaveLength(1);
  });

  it("keeps the first explanation while following up, and retries only the failed question", async () => {
    await message(selection);
    await act(async () => view.root.findByProps({ accessibilityLabel: "AI 解释" }).props.onPress());
    const initial = mocks.explain.mock.calls[0]![2] as Parameters<typeof explainMobileTimesSelection>[2];
    await act(async () => initial.onDone({ model: "gemini", imageCount: 0 }, "这是一种原油。"));
    expect(view.root.findByType("keyboard-avoid" as never).props.behavior).toBe("height");
    await act(async () => view.root.findByProps({ accessibilityLabel: "继续提问" }).props.onChangeText("它为什么更贵？"));
    await act(async () => view.root.findByProps({ accessibilityLabel: "发送追问" }).props.onPress());
    const request = mocks.explain.mock.calls[1]![3];
    expect(request).toMatchObject({ question: "它为什么更贵？", history: [
      { role: "user", content: "请解释选中文字。" }, { role: "assistant", content: "这是一种原油。" },
    ] });
    expect(view.root.findAllByType("span").some((node) => node.props.children === "这是一种原油。")).toBe(true);
    expect(view.root.findByProps({ accessibilityLabel: "继续提问" }).props.value).toBe("");
    const followup = mocks.explain.mock.calls[1]![2] as Parameters<typeof explainMobileTimesSelection>[2];
    await act(async () => followup.onError("连接失败"));
    const retry = view.root.findAllByType("button").find((node) => node.findAllByType("span").some((text) => text.props.children === "重试回答"))!;
    await act(async () => retry.props.onPress());
    expect(mocks.explain.mock.calls[2]![3]).toEqual(request);
    await act(async () => view.root.findAllByType("button").find((node) => node.findAllByType("span").some((text) => text.props.children === "停止生成"))!.props.onPress());
    expect(view.root.findAllByProps({ accessibilityRole: "progressbar" })).toHaveLength(0);
    expect(view.root.findAllByType("span").some((node) => node.props.children === "已停止生成")).toBe(true);
  });
});
