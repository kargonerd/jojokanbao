import { type ComponentProps } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookReaderScreen } from "../screens/BookReaderScreen";
import { NativeSpeechPlayer } from "./SpeechPlayer";
import type { AnnotationSubject, TextAnchor, AnnotationThread, AnnotationVisibility } from "@jojo/content/annotations";

const mocks = vi.hoisted(() => ({
  eInk: false, focused: true, user: { id: "reader" } as { id: string } | null,
  enabled: true, flagUserId: "reader", playbackUnmount: vi.fn(),
  annotationThreads: vi.fn(async () => [] as AnnotationThread[]),
  personalNotes: vi.fn(async () => [] as AnnotationThread[]),
  createAnnotation: vi.fn(),
  annotationComment: vi.fn(), annotationReport: vi.fn(),
  loadChapter: vi.fn(), prefetch: vi.fn(async (_loaded: unknown, _id: string, _signal: AbortSignal) => undefined),
  navigate: vi.fn(), injectJavaScript: vi.fn(), shelfContains: vi.fn(async () => false), setShelf: vi.fn(async () => undefined),
  state: { textScale: 1, bookLineHeight: 1.95, bookReadingMode: "paged", bookPaperColor: "white",
    bookFirstLineIndent: true, hapticsEnabled: false, leftTapNext: false, recentBooks: [], bookAnnotations: [] as import("../store/mobileStore").BookAnnotation[], rememberBook: vi.fn(),
    claimLegacyBookAnnotations: vi.fn(), updateBookAnnotationNote: vi.fn(), removeBookAnnotation: vi.fn(),
    addBookAnnotation: vi.fn((annotation: Record<string, unknown>) => ({ id: "new-annotation", ...annotation })) },
  playback: { open: vi.fn(), close: vi.fn(), toggle: vi.fn(), halt: vi.fn(), seek: vi.fn(), selectChapter: vi.fn(),
    setTimer: vi.fn(), changeVoice: vi.fn(), changeRate: vi.fn(), playing: true, busy: false,
    elapsed: 12, duration: 60, part: 0, chapter: { id: "c1", title: "第一章", segments: ["第一段。这里还有一句。", "第二段。接着朗读。"] },
    voice: { provider: "auto", voice: "male" }, rate: 1, timer: null, error: "", capabilities: undefined },
}));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    ActivityIndicator: "progress", Image: "img", Pressable: "button", ScrollView: "section", KeyboardAvoidingView: "section",
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
    useImperativeHandle(ref, () => ({ injectJavaScript: mocks.injectJavaScript }));
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
  const state = { enabled: mocks.enabled, userId: mocks.flagUserId }; return select ? select(state) : state;
} }));
vi.mock("./useSpeechPlayback", async () => {
  const { useEffect } = await import("react");
  return { useSpeechPlayback: () => {
    useEffect(() => () => mocks.playbackUnmount(), []);
    return mocks.playback;
  } };
});
vi.mock("./SpeechLoading", async () => {
  const { createElement } = await import("react");
  return { SpeechLoading: () => createElement("span", { "data-testid": "speech-loading-bars" }) };
});
vi.mock("./useBookReadingTime", () => ({ useBookReadingTime: () => ({ seconds: 0, recordActivity: () => {} }) }));
vi.mock("./speech", () => ({ speechTime: (value: number) => String(value), mobileSpeechSegments: () => ["正文"] }));
vi.mock("../account/accountData", () => ({ mobileBookshelfContains: mocks.shelfContains, setMobileBookshelf: mocks.setShelf }));
vi.mock("../annotations/api", () => ({
  loadAnnotationThreads: mocks.annotationThreads, loadMyBookAnnotations: mocks.personalNotes,
  createAnnotation: mocks.createAnnotation, addAnnotationComment: mocks.annotationComment, reportAnnotationComment: mocks.annotationReport,
}));
vi.mock("../components/ReaderEnvironment", () => ({ ReaderEnvironment: () => null }));
vi.mock("../components/ReaderNavigationSheet", () => ({ ReaderNavigationSheet: ({ children }: { children: import("react").ReactNode }) => children }));
vi.mock("../components/ReaderSelectionToolbar", async () => {
  const { createElement } = await import("react");
  return { ReaderSelectionToolbar: (props: unknown) => createElement("span", { ...(props as Record<string, unknown>), testID: "selection-toolbar" }) };
});
vi.mock("../components/BookThoughtComposer", async () => {
  const { createElement } = await import("react");
  return { BookThoughtComposer: (props: { quote?: string }) => props.quote === undefined ? null : createElement("div", { ...props, testID: "thought-composer" }) };
});
vi.mock("../annotations/AnnotationDiscussionPanel", async () => {
  const { createElement } = await import("react");
  return { AnnotationDiscussionPanel: (props: unknown) => createElement("div", { ...(props as object), testID: "annotation-discussion" }) };
});
// Listening integration does not initialize native offline storage.
vi.mock("../offline/books", () => ({ useMobileOfflineBooksStore: (select: (state: { identityVersion: number }) => unknown) => select({ identityVersion: 0 }) }));
vi.mock("../lib/bookAgent", () => ({ askMobileBookAgent: vi.fn() }));
vi.mock("../lib/bookDocument", () => ({
  createBookDocument: () => "<html><body><article>正文</article></body></html>",
  createBookChapterMarkup: (fragment: { fragmentId: string }) => `<article data-reader-chapter-id="${fragment.fragmentId}">正文</article>`,
}));
vi.mock("../lib/books", () => ({
  loadMobileBookItem: async () => ({ manifest: { title: "测试书", content: { chapters: [{ id: "c1", title: "第一章", characterCount: 1000 }, { id: "c2", title: "第二章", characterCount: 3000 }] } }, volume: { itemId: "book", title: "测试书" } }),
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
  await readerMessage({ type: "reader-tap" });
}
async function readerMessage(data: object) {
  const reader = view.root.findByProps({ testID: "reader-webview" });
  const readerSessionId = JSON.parse(reader.props.injectedJavaScript.match(/__jojoReaderSessionId = (.*);\n/)[1]);
  await act(async () => reader.props.onMessage({ nativeEvent: { data: JSON.stringify({ ...data, readerSessionId }) } }));
}
async function tick() { await act(async () => { vi.advanceTimersByTime(4000); }); }
const readerProps = { route: { params: { datasetId: "books", itemKey: "book", title: "测试书" } }, navigation: { navigate: mocks.navigate } } as unknown as ComponentProps<typeof BookReaderScreen>;
const readerTool = (label: string) => view.root.findAllByType("button").find((button) => button.findAllByType("span").some((span) => span.props.children === label))!;
async function renderReader(initialized = true) {
  await act(async () => { view = create(<BookReaderScreen {...readerProps} />); });
  if (initialized) {
    const paged = mocks.state.bookReadingMode === "paged";
    await readerMessage({ type: "reader-ready", chapterId: "c1" });
    await readerMessage({ type: "reader-page", chapterId: "c1", paged, spreadIndex: 0, spreadCount: paged ? 10 : 1, pageStart: 1, pageEnd: 1, pageCount: paged ? 10 : 1, pagesPerSpread: 1, scrollProgress: 0 });
  }
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers(); vi.clearAllMocks();
  mocks.eInk = false; mocks.focused = true; mocks.enabled = true; mocks.flagUserId = "reader"; mocks.user = { id: "reader" };
  mocks.state.bookAnnotations = [];
  mocks.annotationThreads.mockReset().mockResolvedValue([]); mocks.personalNotes.mockReset().mockResolvedValue([]);
  mocks.createAnnotation.mockReset().mockImplementation(async (subject: AnnotationSubject, anchor: TextAnchor, note?: string, visibility: AnnotationVisibility = "public") => ({
    ...subject, ...anchor, id: "cloud-annotation", authorId: "reader", authorName: "我", createdAt: "2026-09-12T00:00:00Z", underlinedByMe: true,
    comments: note ? [{ id: "comment-1", annotationId: "cloud-annotation", parentCommentId: null, authorId: "reader", authorName: "我", body: note, visibility, createdAt: "2026-09-12T00:00:00Z", reportedByMe: false }] : [],
  }));
  mocks.state.bookReadingMode = "paged";
  mocks.playback.part = 0; mocks.playback.playing = true; mocks.playback.elapsed = 12; mocks.playback.busy = false;
  mocks.playback.chapter = { id: "c1", title: "第一章", segments: ["第一段。这里还有一句。", "第二段。接着朗读。"] };
  mocks.shelfContains.mockResolvedValue(false); mocks.setShelf.mockResolvedValue(undefined);
  mocks.loadChapter.mockReset().mockImplementation(async (_loaded, id: string) => ({ assetUrls: { portrait: "data:image/png;base64,test" },
    fragment: { fragmentId: id, title: id === "c1" ? "第一章" : "第二章", body: { format: "html", value: "<p>正文</p>" } } }));
});
afterEach(async () => { if (view) await act(async () => view.unmount()); vi.useRealTimers(); });

describe("book thought integration", () => {
  const composer = () => view.root.findByProps({ testID: "thought-composer" });
  const message = readerMessage;
  const tool = (label: string) => view.root.findAllByType("button").find((button) => button.findAllByType("span").some((span) => span.props.children === label))!;
  async function compose() {
    await message({ type: "reader-selection", chapterId: "c1", text: "所选正文", start: 4, end: 8, prefix: "前文", suffix: "后文" });
    await act(async () => view.root.findByProps({ testID: "selection-toolbar" }).props.onThought());
  }

  it("keeps private draft on a failed save and sends the chosen visibility when retried", async () => {
    await renderReader(); await compose();
    expect(composer().props.localOnly).toBe(false);
    expect(composer().props.visibility).toBe("public");
    await act(async () => { composer().props.onChange("只给自己看的想法"); composer().props.onVisibilityChange("private"); });
    mocks.createAnnotation.mockRejectedValueOnce(new Error("offline"));
    await act(async () => composer().props.onSave());
    expect(composer().props.value).toBe("只给自己看的想法");
    expect(composer().props.visibility).toBe("private");
    expect(composer().props.error).toContain("重试");
    await act(async () => composer().props.onSave());
    expect(mocks.createAnnotation).toHaveBeenLastCalledWith(expect.objectContaining({ contentId: "books:book", sectionId: "c1" }), expect.objectContaining({ quote: "所选正文", prefix: "前文", suffix: "后文" }), "只给自己看的想法", "private", "reader");
    expect(view.root.findAllByProps({ testID: "thought-composer" })).toHaveLength(0);
    expect(mocks.state.addBookAnnotation).not.toHaveBeenCalled();
    const notes = view.root.findAllByType("section").find((node) => node.props.data?.some((item: { id: string }) => item.id === "cloud-annotation"));
    expect(notes?.props.data[0].thread.comments[0].visibility).toBe("private");
  });

  it("opens real cloud discussions from an underline instead of editing it as a local note", async () => {
    const thread = await mocks.createAnnotation({ contentType: "book", contentId: "books:book", sectionId: "c1", contentTitle: "测试书" }, { quote: "原文", startOffset: 0, endOffset: 2, prefix: "", suffix: "" }, "公开想法", "public");
    mocks.annotationThreads.mockResolvedValue([thread]);
    await renderReader();
    await message({ type: "reader-annotation", id: thread.id });
    expect(view.root.findByProps({ testID: "annotation-discussion" }).props.thread.comments[0].body).toBe("公开想法");
    expect(view.root.findAllByProps({ testID: "thought-composer" })).toHaveLength(0);
    const created = { ...thread.comments[0], id: "reply", body: "私密补充", visibility: "private" };
    mocks.annotationComment.mockResolvedValueOnce(created);
    await act(async () => view.root.findByProps({ testID: "annotation-discussion" }).props.onComment("私密补充", undefined, "private"));
    expect(mocks.annotationComment).toHaveBeenCalledWith(thread.id, "私密补充", undefined, "private", "reader");
    expect(view.root.findByProps({ testID: "annotation-discussion" }).props.thread.comments).toHaveLength(2);
  });

  it("keeps guest writing local without publishing it", async () => {
    mocks.user = null;
    await renderReader(); await compose();
    expect(composer().props.localOnly).toBe(true);
    await act(async () => composer().props.onChange("离线笔记"));
    await act(async () => composer().props.onSave());
    expect(mocks.createAnnotation).not.toHaveBeenCalled();
    expect(mocks.state.addBookAnnotation).toHaveBeenCalledWith(expect.objectContaining({ ownerId: null, note: "离线笔记" }));
  });

  it("lets the owner choose visibility for an old local thought and keeps it until cloud saving succeeds", async () => {
    mocks.state.bookAnnotations = [{ id: "local", ownerId: "reader", datasetId: "books", itemKey: "book", chapterId: "c1", chapterTitle: "第一章", start: 0, end: 2, quote: "原文", note: "旧想法", createdAt: 1 }];
    await renderReader();
    expect(mocks.createAnnotation).not.toHaveBeenCalled();
    await message({ type: "reader-annotation", id: "local" });
    expect(composer().props.localOnly).toBe(false);
    expect(composer().props.visibility).toBe("private");
    expect(composer().props.value).toBe("旧想法");
    await act(async () => composer().props.onVisibilityChange("public"));
    mocks.createAnnotation.mockRejectedValueOnce(new Error("offline"));
    await act(async () => composer().props.onSave());
    expect(mocks.state.removeBookAnnotation).not.toHaveBeenCalled();
    expect(composer().props.value).toBe("旧想法");
    await act(async () => composer().props.onSave());
    expect(mocks.createAnnotation).toHaveBeenLastCalledWith(expect.objectContaining({ sectionId: "c1" }), expect.objectContaining({ quote: "原文" }), "旧想法", "public", "reader");
    expect(mocks.state.removeBookAnnotation).toHaveBeenCalledExactlyOnceWith("local");
  });

  it("can explicitly keep an offline draft on this device without publishing it", async () => {
    await renderReader(); await compose();
    await act(async () => composer().props.onChange("断网时的想法"));
    mocks.createAnnotation.mockRejectedValueOnce(new Error("offline"));
    await act(async () => composer().props.onSave());
    expect(mocks.state.addBookAnnotation).not.toHaveBeenCalled();
    await act(async () => composer().props.onSaveLocal());
    expect(mocks.createAnnotation).toHaveBeenCalledTimes(1);
    expect(mocks.state.addBookAnnotation).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "reader", note: "断网时的想法" }));
    expect(view.root.findAllByProps({ testID: "thought-composer" })).toHaveLength(0);
  });

  it("does not expose old local note content or another account's notes before ownership is chosen", async () => {
    mocks.state.bookAnnotations = [
      { id: "legacy", datasetId: "books", itemKey: "book", chapterId: "c1", chapterTitle: "第一章", start: 0, end: 1, quote: "旧秘密", note: "旧想法", createdAt: 1 },
      { id: "other", ownerId: "someone", datasetId: "books", itemKey: "book", chapterId: "c1", chapterTitle: "第一章", start: 0, end: 1, quote: "别人秘密", createdAt: 1 },
    ];
    await renderReader(); await act(async () => tool("笔记").props.onPress());
    expect(JSON.stringify(view.toJSON())).not.toContain("旧秘密");
    expect(JSON.stringify(view.toJSON())).not.toContain("别人秘密");
    await act(async () => tool("归入当前账号（保持本地保存）").props.onPress());
    expect(mocks.state.claimLegacyBookAnnotations).toHaveBeenCalledWith("books", "book", "reader");
    expect(mocks.createAnnotation).not.toHaveBeenCalled();
  });

  it("filters the native contents list without opening the keyboard automatically", async () => {
    await renderReader(); await act(async () => tool("目录").props.onPress());
    const filter = view.root.findByProps({ accessibilityLabel: "搜索目录" });
    expect(filter.props.autoFocus).not.toBe(true);
    await act(async () => filter.props.onChangeText("第二"));
    const list = view.root.findAllByType("section").find((node) => node.props.data);
    expect(list?.props.data.map((entry: { title: string }) => entry.title)).toEqual(["第二章"]);
  });
});

describe("continuous chapter reading", () => {
  beforeEach(() => { mocks.state.bookReadingMode = "scroll"; });
  const reader = () => view.root.findByProps({ testID: "reader-webview" });
  const message = readerMessage;
  const page = (chapterId: string, scrollProgress: number) => ({ type: "reader-page", chapterId, paged: false, spreadIndex: 0, spreadCount: 1, pageStart: 1, pageEnd: 1, pageCount: 1, pagesPerSpread: 1, scrollProgress });

  it("appends without replacing the WebView and persists the real chapter when scrolling both ways", async () => {
    await renderReader();
    const initialView = reader();
    const source = initialView.props.source;
    await message({ type: "reader-ready", chapterId: "c1" });
    await message({ type: "reader-chapter-request", chapterId: "c2" });
    expect(mocks.injectJavaScript).toHaveBeenCalledWith(expect.stringContaining('__jojoReaderInsertChapter("c2"'));
    await message(page("c2", .5));
    expect(reader()).toBe(initialView);
    expect(reader().props.source).toBe(source);
    expect(mocks.loadChapter).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(mocks.state.rememberBook).toHaveBeenLastCalledWith(expect.objectContaining({ chapterId: "c2", progress: 62.5, scrollProgress: .5 }));
    await message(page("c1", .8));
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(mocks.state.rememberBook).toHaveBeenLastCalledWith(expect.objectContaining({ chapterId: "c1", progress: 20, scrollProgress: .8 }));
    expect(reader().props.source).toBe(source);
    expect(mocks.loadChapter).toHaveBeenCalledTimes(2);
    expect(mocks.prefetch).not.toHaveBeenCalled();
  });

  it("seeks across chapters in place and keeps the progress panel open", async () => {
    await renderReader();
    const source = reader().props.source;
    await message({ type: "reader-ready", chapterId: "c1" });
    const progressButton = view.root.findAllByType("button").find((button) => button.findAllByType("span").some((span) => span.props.children === "进度"))!;
    await act(async () => progressButton.props.onPress());
    await act(async () => view.root.findByType("input").props.onSlidingComplete(62.5));
    expect(mocks.injectJavaScript).toHaveBeenCalledWith(expect.stringContaining('__jojoReaderInsertChapter("c2"'));
    expect(mocks.injectJavaScript).toHaveBeenLastCalledWith(expect.stringContaining('__jojoReaderGoToChapterProgress(0.5, "c2")'));
    await message(page("c2", .5));
    expect(view.root.findByType("input").props.accessibilityLabel).toBe("全书阅读进度");
    expect(reader().props.source).toBe(source);
  });

  it("keeps loaded content after a chapter failure and retries without resetting the document", async () => {
    await renderReader();
    const source = reader().props.source;
    mocks.loadChapter.mockRejectedValueOnce(new Error("offline"));
    await message({ type: "reader-chapter-request", chapterId: "c2" });
    expect(mocks.injectJavaScript).toHaveBeenLastCalledWith(expect.stringContaining('__jojoReaderChapterFailed("c2")'));
    expect(view.root.findAllByProps({ accessibilityRole: "alert" })).toHaveLength(0);
    expect(reader().props.source).toBe(source);
    await message({ type: "reader-chapter-request", chapterId: "c2" });
    expect(mocks.injectJavaScript).toHaveBeenLastCalledWith(expect.stringContaining('__jojoReaderInsertChapter("c2"'));
  });

  it("saves a selection in its actual chapter even before the debounced visible chapter changes", async () => {
    await renderReader();
    await message({ type: "reader-chapter-request", chapterId: "c2" });
    await message({ type: "reader-selection", chapterId: "c2", text: "第二章的选中文字", start: 6, end: 15 });
    await act(async () => view.root.findByProps({ testID: "selection-toolbar" }).props.onUnderline());
    expect(mocks.createAnnotation).toHaveBeenCalledWith(expect.objectContaining({ sectionId: "c2", contentTitle: "测试书 · 第二章" }), expect.objectContaining({ startOffset: 6, endOffset: 15 }), undefined, "public", "reader");
    expect(mocks.state.addBookAnnotation).not.toHaveBeenCalled();
    expect(mocks.injectJavaScript).toHaveBeenCalledWith(expect.stringContaining('"chapterId":"c2"'));
  });

  it("recovers an explicitly discarded scroll WebView and restores its chapter position", async () => {
    await renderReader();
    await message({ type: "reader-chapter-request", chapterId: "c2" });
    await message(page("c2", .4));
    await act(async () => reader().props.onRenderProcessGone());
    const retry = view.root.findAllByType("button").find((node) => node.findAllByType("span").some((text) => text.props.children === "重新加载"));
    await act(async () => retry!.props.onPress());
    expect(view.root.findAllByProps({ accessibilityRole: "alert" })).toHaveLength(0);
    expect(mocks.loadChapter).toHaveBeenCalledTimes(3);
    await message({ type: "reader-ready", chapterId: "c2" });
    await act(async () => { vi.advanceTimersByTime(90); });
    expect(mocks.injectJavaScript).toHaveBeenCalledWith(expect.stringContaining('__jojoReaderInsertChapter("c1"'));
    expect(mocks.injectJavaScript).toHaveBeenLastCalledWith(expect.stringContaining('__jojoReaderGoToChapterProgress(0.4, "c2")'));
  });

  it("returns from a cross-chapter reference to the link's source chapter and position", async () => {
    await renderReader();
    const source = reader().props.source;
    await message({ type: "reader-ready", chapterId: "c1" });
    await message({ type: "reader-chapter-request", chapterId: "c2" });
    // The last debounced page can still be c1 while a link in c2 is visible.
    await message({ type: "reader-internal-link", chapterId: "c1", anchorId: "note", sourceChapterId: "c2", sourceProgress: .45 });
    expect(mocks.injectJavaScript).toHaveBeenLastCalledWith(expect.stringContaining('__jojoReaderRevealAnchor("note", "c1")'));
    await press("返回原文");
    expect(mocks.injectJavaScript).toHaveBeenLastCalledWith(expect.stringContaining('__jojoReaderGoToChapterProgress(0.45, "c2")'));
    expect(reader().props.source).toBe(source);
  });

  it("requests the visible chapter's reading position and accepts only its current session response", async () => {
    await renderReader();
    const source = reader().props.source;
    await message({ type: "reader-chapter-request", chapterId: "c2" });
    await message(page("c2", .5));
    const player = view.root.findByType(NativeSpeechPlayer);
    expect(player.props.chapterId).toBe("c2");
    let position!: Promise<{ text: string; offset: number } | null>;
    const received = vi.fn();
    await act(async () => { position = player.props.getReadingPosition(); void position.then(received, () => undefined); });
    const script = mocks.injectJavaScript.mock.calls.at(-1)![0] as string;
    const requestId = Number(script.match(/__jojoReaderSpeechPosition\((\d+)\)/)![1]);
    const expected = { text: "第二章正文，现在从这里接着听。", offset: 6 };
    await message({ type: "reader-speech-position", requestId: requestId + 1, position: expected });
    await act(async () => reader().props.onMessage({ nativeEvent: { data: JSON.stringify({ type: "reader-speech-position", requestId, position: expected, readerSessionId: "discarded-session" }) } }));
    expect(received).not.toHaveBeenCalled();
    await message({ type: "reader-speech-position", requestId, position: expected });
    await expect(position).resolves.toEqual(expected);
    expect(reader().props.source).toBe(source);
  });

  it("reveals the spoken chapter and returns to its text without rebuilding the continuous document", async () => {
    mocks.playback.chapter = { id: "c2", title: "第二章", segments: ["第二章正在朗读的正文。"] };
    await renderReader();
    const source = reader().props.source;
    const initialReader = reader();
    await press("打开听读播放器");
    await press("收起播放器");
    await act(async () => { vi.advanceTimersByTime(90); });
    expect(mocks.injectJavaScript).toHaveBeenCalledWith(expect.stringContaining('__jojoReaderInsertChapter("c2"'));
    expect(mocks.injectJavaScript).toHaveBeenCalledWith(expect.stringContaining('__jojoReaderSpeechHighlight({"chapterId":"c2"'));
    expect(reader()).toBe(initialReader);
    expect(reader().props.source).toBe(source);
    await message(page("c2", .4));
    await press("展开听读播放器");
    await act(async () => readerTool("原文").props.onPress());
    expect(view.root.findAllByType("dialog")).toHaveLength(0);
    expect(mocks.injectJavaScript).toHaveBeenLastCalledWith(expect.stringContaining('__jojoReaderSpeechHighlight({"chapterId":"c2"'));
    expect(reader().props.source).toBe(source);
    expect(mocks.loadChapter).toHaveBeenCalledTimes(2);
  });
});

describe.each([false, true])("reader listening visibility (eInk=%s)", (eInk) => {
  beforeEach(() => { mocks.eInk = eInk; });
  it("autoplays only from the launcher and uses loading bars in both player sizes", async () => {
    mocks.playback.busy = true;
    await act(async () => { view = create(<NativeSpeechPlayer documentId="book" title="测试书" chapterId="c1"
      chapters={[{ id: "c1", title: "第一章" }]} loadChapter={mocks.loadChapter} onRead={() => {}} />); });
    await press("打开听读播放器");
    expect(mocks.playback.open).toHaveBeenLastCalledWith(true);
    expect(view.root.findAllByProps({ "data-testid": "speech-loading-bars" })).toHaveLength(1);
    expect(view.root.findAllByType("progress")).toHaveLength(0);
    await press("收起播放器");
    expect(view.root.findAllByProps({ "data-testid": "speech-loading-bars" })).toHaveLength(1);
    await press("取消加载");
    expect(mocks.playback.halt).toHaveBeenCalledOnce();
    await press("展开听读播放器");
    expect(mocks.playback.open).toHaveBeenLastCalledWith(false);
  });
  it("boots inside the document, keeps its source stable, and reports a missing bridge instead of a frozen page", async () => {
    await renderReader(false);
    const reader = () => view.root.findByProps({ testID: "reader-webview" });
    const source = reader().props.source;
    expect(source.html).toContain("<script>");
    expect(source.html).toContain("reader-ready");
    await readerTap();
    expect(reader().props.source).toBe(source);
    await act(async () => reader().props.onLoadEnd());
    expect(mocks.injectJavaScript).toHaveBeenCalledWith(expect.stringContaining("__jojoBookReaderInitialized"));
    await act(async () => { vi.advanceTimersByTime(6000); });
    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(view.root.findByProps({ accessibilityRole: "alert" }).props.children).toContain("阅读页面未能就绪");
  });

  it("accepts the current document's ready acknowledgement and keeps chrome hidden across chapters", async () => {
    await renderReader();
    const message = readerMessage;
    await act(async () => view.root.findByProps({ testID: "reader-webview" }).props.onLoadEnd());
    await message({ type: "reader-ready", chapterId: "c1" });
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(view.root.findAllByProps({ accessibilityRole: "alert" })).toHaveLength(0);
    await readerTap();
    expect(view.root.findAllByProps({ accessibilityLabel: "返回书籍" })).toHaveLength(0);
    await message({ type: "reader-boundary", direction: "next" });
    expect(mocks.loadChapter).toHaveBeenLastCalledWith(expect.anything(), "c2", true, expect.any(AbortSignal));
    expect(view.root.findAllByProps({ accessibilityLabel: "返回书籍" })).toHaveLength(0);
    await readerTap();
    expect(view.root.findAllByProps({ accessibilityLabel: "返回书籍" })).toHaveLength(1);
  });

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

  it("rebuilds the current chapter when it is selected again", async () => {
    await renderReader();
    const source = view.root.findByProps({ testID: "reader-webview" }).props.source;
    await readerMessage({ type: "reader-internal-link", chapterId: "c1" });
    expect(mocks.loadChapter).toHaveBeenCalledTimes(2);
    expect(mocks.loadChapter).toHaveBeenLastCalledWith(expect.anything(), "c1", true, expect.any(AbortSignal));
    expect(view.root.findByProps({ testID: "reader-webview" }).props.source).not.toBe(source);
  });

  it("coalesces saved progress and flushes on exit without restoring the removed header progress", async () => {
    await renderReader();
    const page = (spreadIndex: number) => readerMessage({
        type: "reader-page", paged: true, spreadIndex, spreadCount: 10,
        pageStart: spreadIndex + 1, pageEnd: spreadIndex + 1, pageCount: 10, pagesPerSpread: 1, scrollProgress: 0,
    });
    await page(1); await page(2); await page(3);
    expect(mocks.state.rememberBook).not.toHaveBeenCalled();
    expect(view.root.findAllByType("span").some((node) => JSON.stringify(node.props.children).includes("4 / 10"))).toBe(false);
    await act(async () => { vi.advanceTimersByTime(650); });
    expect(mocks.state.rememberBook).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ datasetId: "books", chapterId: "c1", spreadIndex: 3, progress: 10 }));
    await page(4);
    await act(async () => view.unmount());
    expect(mocks.state.rememberBook).toHaveBeenCalledTimes(2);
    expect(mocks.state.rememberBook).toHaveBeenLastCalledWith(expect.objectContaining({ chapterId: "c1", spreadIndex: 4 }));
  });

  it("converts full-book percentages to a chapter fraction and preserves it through chapter loading", async () => {
    await renderReader();
    const progressButton = view.root.findAllByType("button").find((button) => button.findAllByType("span").some((span) => span.props.children === "进度"))!;
    await act(async () => progressButton.props.onPress());
    const slider = view.root.findByProps({ accessibilityLabel: "全书阅读进度" });
    await act(async () => slider.props.onSlidingComplete(12.5));
    expect(view.root.findByProps({ accessibilityLabel: "全书阅读进度" })).toBeTruthy();
    expect(mocks.injectJavaScript).toHaveBeenCalledWith("window.__jojoReaderGoToChapterProgress && window.__jojoReaderGoToChapterProgress(0.5); true;");
    await act(async () => slider.props.onSlidingComplete(62.5));
    expect(view.root.findByProps({ accessibilityLabel: "全书阅读进度" })).toBeTruthy();
    expect(mocks.loadChapter).toHaveBeenLastCalledWith(expect.anything(), "c2", true, expect.any(AbortSignal));
    await readerMessage({ type: "reader-ready", chapterId: "c2" });
    await act(async () => { vi.advanceTimersByTime(80); });
    expect(mocks.injectJavaScript).toHaveBeenCalledWith("window.__jojoReaderGoToChapterProgress && window.__jojoReaderGoToChapterProgress(0.5); true;");
    expect(view.root.findByProps({ accessibilityLabel: "全书阅读进度" })).toBeTruthy();
  });

  it("starts adjacent prefetch and ignores a late chapter response after navigating back", async () => {
    await renderReader();
    expect(mocks.prefetch).toHaveBeenCalledWith(expect.anything(), "c1", expect.any(AbortSignal));
    let finish!: (value: unknown) => void;
    mocks.loadChapter.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const jump = (id: string) => readerMessage({ type: "reader-internal-link", chapterId: id });
    await jump("c2");
    expect(view.root.findAllByType("span").some((node) => node.props.children === "正在读取章节")).toBe(true);
    const signal = mocks.loadChapter.mock.calls.at(-1)![3] as AbortSignal;
    const progress = view.root.findAllByType("button").find((node) => node.findAllByType("span").some((text) => text.props.children === "进度"));
    await act(async () => progress!.props.onPress());
    await press("上一章");
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
    const openImage = () => readerMessage({ type: "reader-image", assetId: "portrait" });
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
  it("keeps the standalone listening player open until it is explicitly collapsed", async () => {
    await act(async () => { view = create(<NativeSpeechPlayer documentId="news:one" title="新闻" chapterId="c1"
      chapters={[{ id: "c1", title: "新闻" }]} loadChapter={mocks.loadChapter} onRead={() => {}} />); });
    await press("打开听读播放器");
    expect(view.root.findAllByType("dialog")).toHaveLength(1);
    await tick();
    expect(view.root.findAllByType("dialog")).toHaveLength(1);
    expect(view.root.findAllByProps({ accessibilityLabel: "收起播放器" })).toHaveLength(1);
    expect(mocks.playback.close).not.toHaveBeenCalled();
  });

  it("retains paused mini playback when another reading overlay hides it", async () => {
    const content = (hidden = false) => <NativeSpeechPlayer documentId="news:one" title="新闻" chapterId="c1"
      chapters={[{ id: "c1", title: "新闻" }]} loadChapter={mocks.loadChapter} onRead={() => {}} hidden={hidden} />;
    await act(async () => { view = create(content()); });
    await press("打开听读播放器"); await press("收起播放器");
    await tick();
    expect(view.root.findAllByProps({ accessibilityLabel: "展开听读播放器" })).toHaveLength(1);
    await press("暂停听读"); expect(mocks.playback.toggle).toHaveBeenCalledOnce();
    await act(async () => view.update(content(true)));
    expect(view.root.findAllByProps({ accessibilityLabel: "展开听读播放器" })).toHaveLength(0);
    expect(mocks.playback.close).not.toHaveBeenCalled();
    await tick();
    expect(view.root.findAllByProps({ accessibilityLabel: "展开听读播放器" })).toHaveLength(0);
    await act(async () => view.update(content())); await tick();
    expect(view.root.findAllByProps({ accessibilityLabel: "展开听读播放器" })).toHaveLength(1);
    await press("展开听读播放器"); await tick();
    expect(view.root.findAllByType("dialog")).toHaveLength(1);
    await press("收起播放器"); await press("关闭听读");
    expect(mocks.playback.close).toHaveBeenCalledOnce();
    expect(view.root.findAllByProps({ accessibilityLabel: "展开听读播放器" })).toHaveLength(0);
  });

  it("keeps the floating listening launcher above the five reader tools until the reader is tapped", async () => {
    await renderReader(); await tick();
    const launcher = view.root.findByProps({ accessibilityLabel: "打开听读播放器" });
    expect(launcher.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ position: "absolute" }), expect.objectContaining({ bottom: 92 })]));
    const toolbar = readerTool("目录").parent!;
    expect(toolbar.findAllByType("button").map((button) => button.findAllByType("span").map((text) => text.props.children).join(""))).toEqual(["目录", "AI", "进度", "笔记", "文字"]);
    expect(toolbar.findAllByProps({ accessibilityLabel: "打开听读播放器" })).toHaveLength(0);
    expect(view.root.findAllByProps({ accessibilityLabel: "返回书籍" })).toHaveLength(1);
    await readerTap();
    expect(view.root.findAllByProps({ accessibilityLabel: "打开听读播放器" })).toHaveLength(0);
    expect(view.root.findAllByProps({ accessibilityLabel: "返回书籍" })).toHaveLength(0);
    await readerTap();
    expect(view.root.findAllByProps({ accessibilityLabel: "返回书籍" })).toHaveLength(1);
    expect(view.root.findAllByProps({ accessibilityLabel: "打开听读播放器" })).toHaveLength(1);
  });

  it("keeps the reader's expanded player open until it is explicitly collapsed", async () => {
    await renderReader();
    await press("打开听读播放器"); await tick();
    expect(view.root.findAllByType("dialog")).toHaveLength(1);
    expect(view.root.findAllByProps({ accessibilityLabel: "收起播放器" })).toHaveLength(1);
    expect(mocks.playback.open).toHaveBeenCalledExactlyOnceWith(true);
    expect(mocks.playback.close).not.toHaveBeenCalled();
  });

  it("hides and restores the reader mini player with the toolbar and tool panels without closing playback", async () => {
    await renderReader();
    await press("打开听读播放器"); await press("收起播放器"); await tick();
    expect(view.root.findAllByProps({ accessibilityLabel: "展开听读播放器" })).toHaveLength(1);
    await press("暂停听读");
    expect(mocks.playback.toggle).toHaveBeenCalledOnce();
    await readerTap(); await tick();
    expect(view.root.findAllByProps({ accessibilityLabel: "展开听读播放器" })).toHaveLength(0);
    await readerTap();
    expect(view.root.findAllByProps({ accessibilityLabel: "展开听读播放器" })).toHaveLength(1);
    for (const label of ["目录", "AI", "进度", "笔记", "文字"]) {
      await act(async () => readerTool(label).props.onPress());
      expect(view.root.findAllByProps({ accessibilityLabel: "展开听读播放器" })).toHaveLength(0);
      await act(async () => readerTool(label).props.onPress());
      expect(view.root.findAllByProps({ accessibilityLabel: "展开听读播放器" })).toHaveLength(1);
    }
    expect(mocks.playback.close).not.toHaveBeenCalled();
    expect(mocks.playbackUnmount).not.toHaveBeenCalled();
    await press("关闭听读");
    expect(mocks.playback.close).toHaveBeenCalledOnce();
    expect(view.root.findAllByProps({ accessibilityLabel: "打开听读播放器" })).toHaveLength(1);
  });

  it.each(["logout", "flag disabled", "flag belongs to another account", "reader loses focus"])("unmounts the active listening session when %s", async (reason) => {
    await renderReader(); await press("打开听读播放器");
    if (reason === "logout") mocks.user = null;
    else if (reason === "flag disabled") mocks.enabled = false;
    else if (reason === "flag belongs to another account") mocks.flagUserId = "another-reader";
    else mocks.focused = false;
    await act(async () => view.update(<BookReaderScreen {...readerProps} />));
    expect(view.root.findAllByType("dialog")).toHaveLength(0);
    expect(view.root.findAllByProps({ accessibilityLabel: "打开听读播放器" })).toHaveLength(0);
    expect(view.root.findAllByProps({ accessibilityLabel: "展开听读播放器" })).toHaveLength(0);
    expect(mocks.playbackUnmount).toHaveBeenCalledOnce();
    mocks.user = { id: "reader" }; mocks.enabled = true; mocks.flagUserId = "reader"; mocks.focused = true;
    await act(async () => view.update(<BookReaderScreen {...readerProps} />));
    expect(view.root.findAllByProps({ accessibilityLabel: "打开听读播放器" })).toHaveLength(1);
    expect(view.root.findAllByType("dialog")).toHaveLength(0);
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
