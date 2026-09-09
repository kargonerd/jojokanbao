import { type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimesScreen } from "./TimesScreen";
import type { useTimesFeed } from "../lib/useTimesFeed";
import type { TimesDeliveryArticle } from "@jojo/content";

const mocks = vi.hoisted(() => ({ feed: undefined as unknown as ReturnType<typeof useTimesFeed>, apply: vi.fn(), eink: false }));
vi.mock("../lib/useTimesFeed", () => ({ useTimesFeed: () => mocks.feed }));
vi.mock("react-native", async () => {
  const { createElement, Fragment } = await import("react");
  return { ActivityIndicator: "progress", Image: "img", Pressable: "button", Text: "span", View: "div",
    Modal: ({ visible, children }: { visible: boolean; children: ReactNode }) => visible ? children : null,
    FlatList: ({ data, renderItem, keyExtractor }: { data: unknown[]; renderItem: (value: { item: unknown }) => ReactNode; keyExtractor: (item: unknown) => string }) =>
      createElement("section", null, data.map((item) => createElement(Fragment, { key: keyExtractor(item) }, renderItem({ item })))),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Platform: { OS: "android", select: (values: { android: string }) => values.android } };
});
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "i" }));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return { useNavigation: () => ({ navigate() {} }), useFocusEffect: (callback: () => (() => void) | undefined) => useEffect(callback, [callback]) };
});
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "main" }));
vi.mock("../components/ScreenHeader", () => ({ ScreenHeader: "header" }));
vi.mock("../account/auth", () => ({ useMobileAuthStore: (select: (state: unknown) => unknown) => select({ user: { id: "reader" }, initialized: true }) }));
vi.mock("../store/mobileStore", () => ({ useMobileStore: (select: (state: unknown) => unknown) => select({ timesLanguage: "original",
  timesReadArticleIds: [], timesDisabledSourceIds: ["hidden"], hapticsEnabled: false, markTimesArticleRead() {} }) }));
vi.mock("../lib/sourceLogos", () => ({ SOURCE_LOGOS: {} }));
vi.mock("../lib/haptics", () => ({ impactHaptic: vi.fn(), selectionHaptic: vi.fn() }));
vi.mock("../config/appVariant", () => ({ get IS_EINK_RELEASE() { return mocks.eink; } }));
const article = (id: string, source = "visible"): TimesDeliveryArticle => ({ id, title: id, source: { id: source, name: source, language: "zh-CN" },
  publishedAt: "2026-09-09T00:00:00Z", issueDate: "20260909", language: "zh-CN", contentStatus: "full", articleObject: "news.jox", assets: [] });
let view: ReactTestRenderer;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); mocks.apply.mockClear();
  const index = { formatVersion: "jojo-news-timeline-index/1" as const, updatedAt: "1", sources: [article("old").source], dates: [] };
  const page = { formatVersion: "jojo-news-timeline-page/1" as const, date: "20260909", page: 0, updatedAt: "1", articles: [article("旧新闻")] };
  mocks.feed = { index, pages: [page], pendingLatest: { index: { ...index, updatedAt: "2" },
    pages: [{ ...page, articles: [article("新新闻"), article("隐藏来源的新闻", "hidden"), article("旧新闻")] }] },
  nextCursor: null, loading: false, refreshing: false, loadingMore: false, error: "", refresh: vi.fn(), loadMore: vi.fn(), applyLatest: mocks.apply };
});
afterEach(async () => { await act(async () => view?.unmount()); });

describe.each([false, true])("times update notice (eInk=%s)", (eink) => {
  it("shows the old list and a filtered update count until the reader taps the notice", async () => {
    mocks.eink = eink;
    await act(async () => { view = create(<TimesScreen />); });
    const texts = view.root.findAllByType("span").map((node) => node.props.children);
    expect(texts).toContain("旧新闻"); expect(texts).not.toContain("新新闻");
    const notice = view.root.findByProps({ accessibilityLabel: "查看 1 条新动态" });
    expect(mocks.apply).not.toHaveBeenCalled();
    await act(async () => notice.props.onPress());
    expect(mocks.apply).toHaveBeenCalledOnce();
  });
});
