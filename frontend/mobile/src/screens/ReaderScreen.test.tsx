import type { ComponentProps } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderScreen } from "./ReaderScreen";

const mocks = vi.hoisted(() => ({
  eInk: false,
  state: { hapticsEnabled: false, textScale: 1, rememberIssue: vi.fn() },
}));
vi.mock("react-native", () => ({
  ActivityIndicator: "progress", Pressable: "button", Text: "span", View: "div",
  StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {}, hairlineWidth: 1 },
  Platform: { OS: "android", select: (values: { android: string }) => values.android },
  AppState: { addEventListener: () => ({ remove() {} }) },
  BackHandler: { addEventListener: () => ({ remove() {} }) },
  Linking: { openURL: vi.fn() }, Share: { share: vi.fn() },
}));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "i" }));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return { useFocusEffect: (callback: () => () => void) => useEffect(callback, [callback]) };
});
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "main" }));
vi.mock("react-native-webview", async () => {
  const { createElement, forwardRef, useImperativeHandle } = await import("react");
  return { WebView: forwardRef((props, ref) => {
    useImperativeHandle(ref, () => ({ injectJavaScript: vi.fn() }));
    return createElement("article", { ...props, testID: "pdf-webview" });
  }) };
});
vi.mock("../config/appVariant", () => ({ get IS_EINK_RELEASE() { return mocks.eInk; } }));
vi.mock("../components/ReaderEnvironment", () => ({ ReaderEnvironment: () => null }));
vi.mock("../lib/haptics", () => ({ impactHaptic: vi.fn() }));
vi.mock("../store/mobileStore", () => ({
  useMobileStore: (select: (state: typeof mocks.state) => unknown) => select(mocks.state),
}));

let view: ReactTestRenderer;
const webview = () => view.root.findByProps({ testID: "pdf-webview" });
async function page(current: number, total = 8, url = "https://reader.jojokanbao.cn/archive/rmrb/20260906") {
  await act(async () => webview().props.onMessage({ nativeEvent: {
    data: JSON.stringify({ type: "page", current, total, url }),
  } }));
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers(); vi.clearAllMocks();
});
async function renderReader(params: Record<string, unknown> = {}) {
  const props = {
    route: { params: { publication: "rmrb", issueId: "20260906", ...params } },
    navigation: { goBack: vi.fn() },
  } as unknown as ComponentProps<typeof ReaderScreen>;
  await act(async () => { view = create(<ReaderScreen {...props} />); });
}
afterEach(async () => { await act(async () => view.unmount()); vi.useRealTimers(); });

describe.each([false, true])("PDF progress (eInk=%s)", (eInk) => {
  beforeEach(() => { mocks.eInk = eInk; });

  it("saves page reports without a ready event and flushes the last page on quick exit", async () => {
    await renderReader();
    await act(async () => webview().props.onLoadStart());
    await page(1); await page(2);
    expect(mocks.state.rememberIssue).not.toHaveBeenCalled();
    expect(view.root.findAllByType("span").some((node) => JSON.stringify(node.props.children).includes("2/8"))).toBe(true);
    await act(async () => { vi.advanceTimersByTime(650); });
    expect(mocks.state.rememberIssue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ currentPage: 2, totalPages: 8 }));
    await act(async () => webview().props.onLoadStart());
    await page(3);
    await act(async () => view.unmount());
    expect(mocks.state.rememberIssue).toHaveBeenLastCalledWith(expect.objectContaining({ currentPage: 3, issueId: "20260906" }));
    expect(mocks.state.rememberIssue).toHaveBeenCalledTimes(2);
  });

  it("does not persist an unloaded document and associates a new issue with its own page", async () => {
    await renderReader();
    await page(1, 0);
    await act(async () => { vi.advanceTimersByTime(650); });
    expect(mocks.state.rememberIssue).not.toHaveBeenCalled();
    await page(4, 6, "https://reader.jojokanbao.cn/archive/ckxx/19980101#page-4");
    await act(async () => { vi.advanceTimersByTime(650); });
    expect(mocks.state.rememberIssue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      publication: "ckxx", issueId: "19980101", title: "参考消息", currentPage: 4, totalPages: 6,
    }));
  });
});


it("passes a native search hit into the embedded reader without losing the PDF page", async () => {
  await renderReader({ page: 3, searchQuery: "铁路", searchQuote: "铁路通车" });
  const url = new URL(webview().props.source.uri);
  expect(url.pathname).toBe("/archive/rmrb/20260906");
  expect(url.hash).toBe("#page-3");
  expect(url.searchParams.get("query")).toBe("铁路");
  expect(url.searchParams.get("quote")).toBe("铁路通车");
  expect(url.searchParams.get("searchPage")).toBe("3");
});

it("preserves the complete long article title from native search in the embedded reader", async () => {
  const title = `${"教育".repeat(100)}者要先受教育……`;
  await renderReader({ page: 2, searchQuery: "教育", searchTitle: title });
  const url = new URL(webview().props.source.uri);
  expect(url.searchParams.get("title")).toBe(title);
  expect(url.searchParams.has("quote")).toBe(false);
  expect(url.hash).toBe("#page-2");
});
