import { type ComponentProps } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookReaderScreen } from "../screens/BookReaderScreen";
import { NativeSpeechPlayer } from "./SpeechPlayer";

const mocks = vi.hoisted(() => ({
  eInk: false, focused: true, user: { id: "reader" } as { id: string } | null,
  enabled: true,
  loadChapter: vi.fn(), prefetch: vi.fn(async (_loaded: unknown, _id: string, _signal: AbortSignal) => undefined),
  navigate: vi.fn(), shelfContains: vi.fn(async () => false), setShelf: vi.fn(async () => undefined),
  state: { textScale: 1, bookLineHeight: 1.95, bookReadingMode: "paged", bookPaperColor: "white",
    bookFirstLineIndent: true, hapticsEnabled: false, leftTapNext: false, recentBooks: [], bookAnnotations: [], rememberBook: vi.fn() },
  playback: { open: vi.fn(), close: vi.fn(), toggle: vi.fn(), seek: vi.fn(), selectChapter: vi.fn(),
    setTimer: vi.fn(), changeVoice: vi.fn(), changeRate: vi.fn(), playing: true, busy: false,
    elapsed: 12, duration: 60, part: 0, chapter: { id: "c1", title: "第一章", segments: ["第一段。这里还有一句。", "第二段。接着朗读。"] },
    voice: { provider: "auto", voice: "male" }, rate: 1, timer: null, error: "", capabilities: undefined },
}));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    ActivityIndicator: "progress", Image: "img", Pressable: "button", ScrollView: "section",
    Text: "span", TextInput: "input", View: "div", FlatList: "section",
    Modal: ({ visible, children, ...props }: { visible: boolean; children: import("react").ReactNode }) =>
      visible ? createElement("dialog", props, children) : null,
    StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {}, hairlineWidth: 1 },
    Platform: { OS: "android", select: (values: { android: string }) => values.android },
    AppState: { addEventListener: () => ({ remove() {} }) },
  };
});
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "i" }));
vi.mock("@expo/vector-icons/MaterialCommunityIcons", () => ({ default: "i" }));
vi.mock("@react-native-community/slider", () => ({ default: "input" }));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return {
    useIsFocused: () => mocks.focused,
    useFocusEffect: (callback: () => () => void) => useEffect(() => {
      if (mocks.focused) return callback();
    }, [callback, mocks.focused]),
  };
});
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "main", useSafeAreaInsets: () => ({ top: 0, bottom: 12 }) }));
vi.mock("react-native-webview", async () => {
  const { createElement, forwardRef, useImperativeHandle } = await import("react");
  return { WebView: forwardRef((props, ref) => {
    useImperativeHandle(ref, () => ({ injectJavaScript: vi.fn() }));
    return createElement("article", { ...props, testID: "reader-webview" });
  }) };
});
vi.mock("expo-brightness", () => ({ getBrightnessAsync: async () => 0.6 }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("../config/appVariant", () => ({ get IS_EINK_RELEASE() { return mocks.eInk; } }));
vi.mock("../theme/tokens", async (importOriginal) => {
  const themes = await importOriginal<typeof import("../theme/tokens")>();
  return { ...themes, get mobileTheme() { return mocks.eInk ? themes.eInkTheme : themes.editorialTheme; } };
});
vi.mock("../account/auth", () => ({ useMobileAuthStore: (select: (state: { user: typeof mocks.user }) => unknown) => select({ user: mocks.user }) }));
vi.mock("./featureFlag", () => ({ useSpeechFlagStore: (select?: (state: unknown) => unknown) => {
  const state = { enabled: mocks.enabled, userId: "reader" }; return select ? select(state) : state;
} }));
vi.mock("./useSpeechPlayback", () => ({ useSpeechPlayback: () => mocks.playback }));
vi.mock("./speech", () => ({ speechTime: (value: number) => String(value), mobileSpeechSegments: () => ["正文"] }));
vi.mock("../account/accountData", () => ({ mobileBookshelfContains: mocks.shelfContains, setMobileBookshelf: mocks.setShelf }));
vi.mock("../components/ReaderEnvironment", () => ({ ReaderEnvironment: () => null }));
vi.mock("../components/ReaderNavigationSheet", () => ({ ReaderNavigationSheet: () => null }));
vi.mock("../components/ReaderSelectionToolbar", () => ({ ReaderSelectionToolbar: () => null }));
vi.mock("../components/BookThoughtComposer", () => ({ BookThoughtComposer: () => null }));
// Material tools have their own tests; listening integration does not initialize
// their Supabase repositories.
vi.mock("../scrapbook/ScrapbookButton", () => ({ ScrapbookButton: () => null, ScrapbookCapture: () => null }));
vi.mock("../lib/bookAgent", () => ({ askMobileBookAgent: vi.fn() }));
vi.mock("../lib/bookDocument", () => ({ createBookDocument: () => "<p>正文</p>" }));
vi.mock("../lib/books", () => ({
  loadMobileBookItem: async () => ({ manifest: { title: "测试书", content: { chapters: [{ id: "c1", title: "第一章" }, { id: "c2", title: "第二章" }] } }, volume: { itemId: "book", title: "测试书" } }),
  loadMobileBookChapter: mocks.loadChapter,
  loadMobileBookCover: async () => undefined, resolveLegacyBookResume: () => undefined,
  prefetchMobileBookChapters: mocks.prefetch,
}));
vi.mock("../lib/haptics", () => ({ selectionHaptic: vi.fn() }));
vi.mock("../store/mobileStore", () => ({ useMobileStore: Object.assign(
  (select: (state: typeof mocks.state) => unknown) => select(mocks.state), { getState: () => mocks.state },
) }));

let view: ReactTestRenderer;
async function press(label: string) {
  await act(async () => view.root.findByProps({ accessibilityLabel: label }).props.onPress());
}
async function readerTap() {
  await act(async () => view.root.findByProps({ testID: "reader-webview" }).props.onMessage({ nativeEvent: { data: JSON.stringify({ type: "reader-tap" }) } }));
}
async function tick() { await act(async () => { vi.advanceTimersByTime(4000); }); }
async function renderReader() {
  const props = { route: { params: { datasetId: "books", itemKey: "book", title: "测试书" } }, navigation: { navigate: mocks.navigate } } as unknown as ComponentProps<typeof BookReaderScreen>;
  await act(async () => { view = create(<BookReaderScreen {...props} />); });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers(); vi.clearAllMocks();
  mocks.eInk = false; mocks.focused = true; mocks.enabled = true; mocks.user = { id: "reader" };
  mocks.playback.part = 0; mocks.playback.playing = true; mocks.playback.elapsed = 12;
  mocks.shelfContains.mockResolvedValue(false); mocks.setShelf.mockResolvedValue(undefined);
  mocks.loadChapter.mockReset().mockImplementation(async (_loaded, id: string) => ({ assetUrls: { portrait: "data:image/png;base64,test" },
    fragment: { fragmentId: id, title: id === "c1" ? "第一章" : "第二章", body: { format: "html", value: "<p>正文</p>" } } }));
});
afterEach(async () => { if (view) await act(async () => view.unmount()); vi.useRealTimers(); });

describe.each([false, true])("reader listening visibility (eInk=%s)", (eInk) => {
  beforeEach(() => { mocks.eInk = eInk; });
  it("reports the current speech location in mini mode and retains it when paused", async () => {
    const onSpeechLocation = vi.fn();
    const onRead = vi.fn();
    const content = () => <NativeSpeechPlayer documentId="book" title="测试书" chapterId="c1"
      chapters={[{ id: "c1", title: "第一章" }]} loadChapter={mocks.loadChapter} onRead={onRead} onSpeechLocation={onSpeechLocation} />;
    await act(async () => { view = create(content()); });
    await press("打开听读播放器");
    expect(onSpeechLocation).toHaveBeenLastCalledWith(null, true);
    await press("收起播放器");
    const location = { chapterId: "c1", segments: mocks.playback.chapter.segments, index: 0 };
    expect(onSpeechLocation).toHaveBeenLastCalledWith(location, true);
    const updates = onSpeechLocation.mock.calls.length;
    mocks.playback.elapsed = 18;
    await act(async () => view.update(content()));
    expect(onSpeechLocation).toHaveBeenCalledTimes(updates);
    mocks.playback.playing = false;
    await act(async () => view.update(content()));
    expect(onSpeechLocation).toHaveBeenLastCalledWith(location, false);
    mocks.playback.part = 1; mocks.playback.playing = true;
    await act(async () => view.update(content()));
    expect(onSpeechLocation).toHaveBeenLastCalledWith({ ...location, index: 1 }, true);
    await press("关闭听读");
    expect(onSpeechLocation).toHaveBeenLastCalledWith(null, true);
  });

  it("updates page controls immediately while coalescing saved progress and flushes on exit", async () => {
    await renderReader();
    const page = async (spreadIndex: number) => act(async () => {
      view.root.findByProps({ testID: "reader-webview" }).props.onMessage({ nativeEvent: { data: JSON.stringify({
        type: "reader-page", paged: true, spreadIndex, spreadCount: 10,
        pageStart: spreadIndex + 1, pageEnd: spreadIndex + 1, pageCount: 10, pagesPerSpread: 1, scrollProgress: 0,
      }) } });
    });
    await page(1); await page(2); await page(3);
    expect(mocks.state.rememberBook).not.toHaveBeenCalled();
    expect(view.root.findAllByType("span").some((node) => JSON.stringify(node.props.children).includes("4 / 10"))).toBe(true);
    await act(async () => { vi.advanceTimersByTime(650); });
    expect(mocks.state.rememberBook).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ datasetId: "books", chapterId: "c1", spreadIndex: 3 }));
    await page(4);
    await act(async () => view.unmount());
    expect(mocks.state.rememberBook).toHaveBeenCalledTimes(2);
    expect(mocks.state.rememberBook).toHaveBeenLastCalledWith(expect.objectContaining({ chapterId: "c1", spreadIndex: 4 }));
  });

  it("starts adjacent prefetch and ignores a late chapter response after navigating back", async () => {
    await renderReader();
    expect(mocks.prefetch).toHaveBeenCalledWith(expect.anything(), "c1", expect.any(AbortSignal));
    let finish!: (value: unknown) => void;
    mocks.loadChapter.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const jump = async (id: string) => {
      await act(async () => view.root.findByProps({ testID: "reader-webview" }).props.onMessage({ nativeEvent: {
        data: JSON.stringify({ type: "reader-internal-link", chapterId: id }),
      } }));
    };
    const message = view.root.findByProps({ testID: "reader-webview" }).props.onMessage;
    await jump("c2");
    expect(view.root.findAllByType("span").some((node) => node.props.children === "正在读取章节")).toBe(true);
    const signal = mocks.loadChapter.mock.calls.at(-1)![3] as AbortSignal;
    await act(async () => message({ nativeEvent: { data: JSON.stringify({ type: "reader-internal-link", chapterId: "c1" }) } }));
    expect(signal.aborted).toBe(true);
    await act(async () => finish({ assetUrls: {}, fragment: { fragmentId: "c2", title: "旧请求" } }));
    expect(view.root.findAllByType("span").some((node) => node.props.children === "正在读取章节")).toBe(false);
    expect(mocks.prefetch.mock.calls.at(-1)![1]).toBe("c1");
  });

  it("shows a recoverable error when Android discards the WebView process", async () => {
    await renderReader();
    await act(async () => view.root.findByProps({ testID: "reader-webview" }).props.onRenderProcessGone());
    expect(view.root.findByProps({ accessibilityRole: "alert" }).props.children).toContain("系统回收");
    const retry = view.root.findAllByType("button").find((node) => node.findAllByType("span").some((text) => text.props.children === "重新加载"));
    await act(async () => retry!.props.onPress());
    expect(view.root.findAllByProps({ accessibilityRole: "alert" })).toHaveLength(0);
    expect(view.root.findAllByProps({ testID: "reader-webview" })).toHaveLength(1);
  });
  it("offers a labelled bookshelf action without enabling listening, including login and retry", async () => {
    mocks.enabled = false;
    mocks.shelfContains.mockRejectedValueOnce(new Error("offline"));
    await renderReader();
    const add = view.root.findByProps({ accessibilityLabel: "加入书架" });
    expect(add.findAllByType("span").some((text) => text.props.children === "加入书架")).toBe(true);
    await press("加入书架");
    expect(mocks.setShelf).toHaveBeenCalledWith({ datasetId: "books", itemId: "book", title: "测试书", added: true });
    await press("移出书架");
    expect(mocks.setShelf).toHaveBeenLastCalledWith({ datasetId: "books", itemId: "book", title: "测试书", added: false });
    mocks.user = null;
    await act(async () => view.unmount());
    await renderReader();
    await press("加入书架");
    expect(mocks.navigate).toHaveBeenCalledWith("Account");
  });

  it("closes image previews from the full image surface or Android back without changing reader chrome", async () => {
    await renderReader();
    const openImage = async () => act(async () => view.root.findByProps({ testID: "reader-webview" }).props.onMessage({ nativeEvent: { data: JSON.stringify({ type: "reader-image", assetId: "portrait" }) } }));
    await openImage();
    const surface = view.root.findByProps({ accessibilityLabel: "关闭图片预览" });
    expect(surface.props.style).toMatchObject({ flex: 1 });
    expect(surface.findByType("img").parent?.props.pointerEvents).toBe("none");
    expect(surface.findAllByProps({ name: "close" })).toHaveLength(0);
    await press("关闭图片预览");
    expect(view.root.findAllByType("dialog")).toHaveLength(0);
    expect(view.root.findAllByProps({ accessibilityLabel: "返回书籍" })).toHaveLength(1);
    await openImage();
    await act(async () => view.root.findByType("dialog").props.onRequestClose());
    expect(view.root.findAllByType("dialog")).toHaveLength(0);
  });
  it("keeps the expanded player open beyond the former 3.2-second reader timeout", async () => {
    await renderReader();
    await press("打开听读播放器");
    expect(view.root.findAllByType("dialog")).toHaveLength(1);
    await tick();
    expect(view.root.findAllByType("dialog")).toHaveLength(1);
    expect(view.root.findAllByProps({ accessibilityLabel: "收起播放器" })).toHaveLength(1);
    expect(mocks.playback.close).not.toHaveBeenCalled();
  });

  it("keeps mini visible until a reader tap, then restores it on the next tap without closing audio", async () => {
    await renderReader(); await press("打开听读播放器"); await press("收起播放器");
    await tick();
    expect(view.root.findAllByProps({ accessibilityLabel: "展开听读播放器" })).toHaveLength(1);
    await press("暂停听读"); expect(mocks.playback.toggle).toHaveBeenCalledOnce();
    await readerTap();
    expect(view.root.findAllByProps({ accessibilityLabel: "展开听读播放器" })).toHaveLength(0);
    expect(mocks.playback.close).not.toHaveBeenCalled();
    await tick();
    expect(view.root.findAllByProps({ accessibilityLabel: "展开听读播放器" })).toHaveLength(0);
    await readerTap(); await tick();
    expect(view.root.findAllByProps({ accessibilityLabel: "展开听读播放器" })).toHaveLength(1);
    await press("展开听读播放器"); await tick();
    expect(view.root.findAllByType("dialog")).toHaveLength(1);
    await press("收起播放器"); await press("关闭听读");
    expect(mocks.playback.close).toHaveBeenCalledOnce();
    expect(view.root.findAllByProps({ accessibilityLabel: "展开听读播放器" })).toHaveLength(0);
  });

  it("keeps the toolbar and launcher visible until a reader tap, not a timeout", async () => {
    await renderReader(); await tick();
    expect(view.root.findAllByProps({ accessibilityLabel: "打开听读播放器" })).toHaveLength(1);
    expect(view.root.findAllByProps({ accessibilityLabel: "返回书籍" })).toHaveLength(1);
    await readerTap();
    expect(view.root.findAllByProps({ accessibilityLabel: "打开听读播放器" })).toHaveLength(0);
    expect(view.root.findAllByProps({ accessibilityLabel: "返回书籍" })).toHaveLength(0);
    await readerTap();
    expect(view.root.findAllByProps({ accessibilityLabel: "打开听读播放器" })).toHaveLength(1);
  });
});

it("keeps news listening visible and only yields to an explicit article overlay", async () => {
  const props = { news: true, documentId: "news:one", title: "新闻", chapterId: "c1",
    chapters: [{ id: "c1", title: "新闻" }], loadChapter: vi.fn(), onRead: vi.fn() };
  await act(async () => { view = create(<NativeSpeechPlayer {...props} />); });
  await press("打开听读播放器"); await tick();
  expect(view.root.findAllByType("dialog")).toHaveLength(1);
  expect(view.root.findAllByType("span").some((node) => node.props.children === "男声")).toBe(true);
  expect(view.root.findAllByType("span").some((node) => node.props.children === "male")).toBe(false);
  await press("收起播放器"); await tick();
  expect(view.root.findAllByProps({ accessibilityLabel: "展开听读播放器" })).toHaveLength(1);
  await act(async () => view.update(<NativeSpeechPlayer {...props} hidden />));
  expect(view.root.findAllByProps({ accessibilityLabel: "展开听读播放器" })).toHaveLength(0);
  expect(mocks.playback.close).not.toHaveBeenCalled();
  await act(async () => view.update(<NativeSpeechPlayer {...props} />));
  expect(view.root.findAllByProps({ accessibilityLabel: "展开听读播放器" })).toHaveLength(1);
});

it("uses the news photo first, then a small publisher mark and name without duplicating the headline", async () => {
  const props = { news: true, documentId: "news:cover", title: "新闻标题", sourceName: "Reuters", chapterId: "c1",
    cover: { uri: "https://example.test/photo.jpg" }, coverFallback: 42,
    chapters: [{ id: "c1", title: "新闻标题" }], loadChapter: vi.fn(), onRead: vi.fn() };
  await act(async () => { view = create(<NativeSpeechPlayer {...props} />); });
  await press("打开听读播放器");
  const foreground = () => view.root.findAllByType("img").find((node) => !node.props.blurRadius)!;
  expect(foreground().props.source).toEqual(props.cover);
  await act(async () => foreground().props.onError());
  expect(foreground().props.source).toBe(42);
  expect(foreground().props.resizeMode).toBe("contain");
  expect(foreground().props.style).toMatchObject({ width: 24, height: 24 });
  expect(view.root.findAllByType("span").filter((node) => node.props.children === "新闻标题")).toHaveLength(1);
  expect(view.root.findAllByType("span").filter((node) => node.props.children === "Reuters")).toHaveLength(1);
  await act(async () => foreground().props.onError());
  expect(view.root.findAllByType("img")).toHaveLength(0);
  expect(view.root.findAllByType("span").some((node) => node.props.children === "Reuters")).toBe(true);
});
