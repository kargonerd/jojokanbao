import Ionicons from "@expo/vector-icons/Ionicons";
import { bookProgressPercent, bookProgressLocation, estimatedReadingMinutes, formatReadingTime, type SpeechLocation, type SpeechReadingPosition } from "@jojo/content";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Brightness from "expo-brightness";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, FlatList, Image, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { mobileBookshelfContains, setMobileBookshelf } from "../account/accountData";
import { useMobileAuthStore } from "../account/auth";
import { ReaderEnvironment } from "../components/ReaderEnvironment";
import { BookReaderWebView } from "../components/BookReaderWebView";
import { ReaderNavigationSheet } from "../components/ReaderNavigationSheet";
import { ReaderSlider } from "../components/ReaderSlider";
import { ReaderSelectionToolbar } from "../components/ReaderSelectionToolbar";
import { BookThoughtComposer } from "../components/BookThoughtComposer";
import { AnnotationDiscussionPanel } from "../annotations/AnnotationDiscussionPanel";
import { annotationError, useBookAnnotations } from "../annotations/useBookAnnotations";
import type { AnnotationThread, AnnotationVisibility } from "@jojo/content/annotations";
import { BookshelfButton } from "../components/BookshelfButton";
import { useMobileOfflineBooksStore } from "../offline/books";
import { useReadingProgress } from "../reading/useReadingProgress";
import { NativeSpeechPlayer } from "../reading/SpeechPlayer";
import { mobileSpeechSegments } from "../reading/speech";
import { useSpeechFlagStore } from "../reading/featureFlag";
import { useBookReadingTime } from "../reading/useBookReadingTime";
import { bookTocEntries, type BookTocEntry } from "../lib/bookToc";
import { IS_EINK_RELEASE } from "../config/appVariant";
import {
  askMobileBookAgent,
  type MobileBookAgentReference,
} from "../lib/bookAgent";
import { createBookChapterMarkup, createBookDocument } from "../lib/bookDocument";
import {
  createBookReaderApplyAnnotationScript,
  createBookReaderBridgeScript,
  createBookReaderClearSelectionScript,
  createBookReaderInsertChapterScript,
  createBookReaderChapterFailedScript,
  createBookReaderGoToChapterProgressScript,
  createBookReaderGoToSpreadScript,
  createBookReaderLocateTextScript,
  createBookReaderMeasureScript,
  createBookReaderRemoveAnnotationScript,
  createBookReaderRevealAnchorScript,
  createBookReaderSpeechPositionScript,
  createBookReaderSpeechHighlightScript,
  parseBookReaderMessage,
  type BookChapterEdge,
  type BookReaderPageMessage,
  type BookReaderSelectionMessage,
  type BookReadingMode,
} from "../lib/bookReaderBridge";
import {
  loadMobileBookChapter,
  loadMobileBookCover,
  loadMobileBookItem,
  loadMobileBookVolumes,
  prefetchMobileBookChapters,
  resolveLegacyBookResume,
  resolveMobileAnnotationReference,
  searchMobileBook,
  type LoadedMobileBookChapter,
  type LoadedMobileBookItem,
  type MobileBookSearchResult,
} from "../lib/books";
import { selectionHaptic } from "../lib/haptics";
import { useRetryOnFailure } from "../lib/useRetryOnFailure";
import type { RootStackParamList } from "../navigation/types";
import { useMobileStore, type BookAnnotation, type BookPaperColor } from "../store/mobileStore";
import { mobileTheme, type MobileTheme } from "../theme/tokens";

type Props = NativeStackScreenProps<RootStackParamList, "BookReader">;
type ReaderTool = "toc" | "search" | "ai" | "progress" | "notes" | "text";
type AiMessage = { role: "user" | "assistant"; content: string; references?: MobileBookAgentReference[] };
type NoteComposer = { annotationId?: string; selection?: BookReaderSelectionMessage; quote: string };
type ReaderAnnotation = BookAnnotation & { thread?: AnnotationThread };
type PendingLocate = { chapterId: string; text?: string; anchorId?: string; spreadIndex?: number; scrollProgress?: number; chapterProgress?: number };

function readerTheme(color: BookPaperColor): MobileTheme {
  if (IS_EINK_RELEASE || color === "white") return mobileTheme;
  if (color === "ivory") return { ...mobileTheme, paper: "#fbfaf6", paperSoft: "#f4f1e9" };
  return {
    ...mobileTheme,
    red: "#d46666",
    redDark: "#e18888",
    ink: "#deded8",
    muted: "#a8aaa6",
    rule: "#393d3a",
    ruleDark: "#686c68",
    paper: "#202321",
    paperSoft: "#181a19",
    inverse: "#202321",
  };
}

export function BookReaderScreen({ route, navigation }: Props) {
  const { datasetId, itemKey, title, bookTitle, initialChapterId, initialAnchorId, initialText, returnToReference } = route.params;
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView>(null);
  const pendingLocateRef = useRef<PendingLocate | undefined>(undefined);
  const cancelAgentRef = useRef<(() => void) | undefined>(undefined);
  const aiBookRouteRef = useRef("");
  const scrollChaptersRef = useRef(new Map<string, LoadedMobileBookChapter>());
  const scrollRequestsRef = useRef(new Map<string, Promise<LoadedMobileBookChapter | undefined>>());
  const scrollGenerationRef = useRef(0);
  const scrollSeekRef = useRef(0);

  const textScale = useMobileStore((state) => state.textScale);
  const setTextScale = useMobileStore((state) => state.setTextScale);
  const bookLineHeight = useMobileStore((state) => state.bookLineHeight);
  const setBookLineHeight = useMobileStore((state) => state.setBookLineHeight);
  const bookReadingMode = useMobileStore((state) => state.bookReadingMode);
  const readingModeRef = useRef(bookReadingMode);
  readingModeRef.current = bookReadingMode;
  const setBookReadingMode = useMobileStore((state) => state.setBookReadingMode);
  const bookPaperColor = useMobileStore((state) => state.bookPaperColor);
  const setBookPaperColor = useMobileStore((state) => state.setBookPaperColor);
  const bookFirstLineIndent = useMobileStore((state) => state.bookFirstLineIndent);
  const setBookFirstLineIndent = useMobileStore((state) => state.setBookFirstLineIndent);
  const hapticsEnabled = useMobileStore((state) => state.hapticsEnabled);
  const user = useMobileAuthStore((state) => state.user);
  const offlineIdentityVersion = useMobileOfflineBooksStore((state) => state.identityVersion);
  const leftTapNext = useMobileStore((state) => state.leftTapNext);
  const rememberBook = useMobileStore((state) => state.rememberBook);
  const readingProgress = useReadingProgress(rememberBook);
  const recentBook = useMobileStore((state) => state.recentBooks.find((candidate) => (
    candidate.datasetId === datasetId && candidate.itemKey === itemKey
  )));
  const annotations = useMobileStore((state) => state.bookAnnotations);
  const addBookAnnotation = useMobileStore((state) => state.addBookAnnotation);
  const updateBookAnnotationNote = useMobileStore((state) => state.updateBookAnnotationNote);
  const removeBookAnnotation = useMobileStore((state) => state.removeBookAnnotation);
  const claimLegacyBookAnnotations = useMobileStore((state) => state.claimLegacyBookAnnotations);

  const theme = useMemo(() => readerTheme(bookPaperColor), [bookPaperColor]);
  const [loaded, setLoaded] = useState<LoadedMobileBookItem>();
  const [chapter, setChapter] = useState<LoadedMobileBookChapter>();
  const [activeChapterId, setActiveChapterId] = useState("");
  const [itemLoading, setItemLoading] = useState(true);
  const [chapterLoading, setChapterLoading] = useState(false);
  const loading = itemLoading || chapterLoading;
  const [error, setError] = useState("");
  const [chromeVisible, setChromeVisible] = useState(true);
  const [activeTool, setActiveTool] = useState<ReaderTool | null>(null);
  const [pageState, setPageState] = useState<BookReaderPageMessage>();
  const [chapterEntryEdge, setChapterEntryEdge] = useState<BookChapterEdge>("start");
  const [retryToken, setRetryToken] = useState(0);
  const [chapterRetryToken, setChapterRetryToken] = useState(0);
  function retryReading() {
    if (loaded) {
      if (bookReadingMode === "scroll") {
        pendingLocateRef.current = { chapterId: activeChapterId, scrollProgress: pageState?.scrollProgress ?? 0 };
        readerReadyChapterRef.current = "";
        setChapter(undefined);
      }
      setChapterRetryToken((value) => value + 1);
    }
    else setRetryToken((value) => value + 1);
  }
  useRetryOnFailure(Boolean(error) && !loading, retryReading);
  const [dragProgress, setDragProgress] = useState<number>();
  const tocListRef = useRef<FlatList<BookTocEntry>>(null);
  const [selection, setSelection] = useState<BookReaderSelectionMessage>();
  const [readerFrame, setReaderFrame] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const [noteComposer, setNoteComposer] = useState<NoteComposer>();
  const [noteDraft, setNoteDraft] = useState("");
  const [noteVisibility, setNoteVisibility] = useState<AnnotationVisibility>("public");
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState("");
  const noteRequestRef = useRef<string | null>(null);
  const noteContext = JSON.stringify([user?.id ?? null, datasetId, itemKey]);
  const noteContextRef = useRef(noteContext);
  noteContextRef.current = noteContext;
  const [activeAnnotationId, setActiveAnnotationId] = useState<string>();
  const [brightness, setBrightness] = useState(0.65);
  const [searchQuery, setSearchQuery] = useState("");
  const [tocQuery, setTocQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MobileBookSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchSearched, setSearchSearched] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [aiInput, setAiInput] = useState("");
  const [aiMessages, setAiMessages] = useState<AiMessage[]>([]);
  const [aiStream, setAiStream] = useState("");
  const [aiError, setAiError] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string>();
  const [referenceHistory, setReferenceHistory] = useState<Array<{ chapterId: string; spreadIndex?: number; scrollProgress?: number }>>([]);
  const [expandedImageUri, setExpandedImageUri] = useState<string>();
  const [readerNotice, setReaderNotice] = useState("");
  const [onBookshelf, setOnBookshelf] = useState<boolean>();
  const [bookshelfBusy, setBookshelfBusy] = useState(false);
  const [legacyResume, setLegacyResume] = useState<{ chapterId: string; chapterProgress: number }>();
  const readerReadyChapterRef = useRef("");
  const readingChapterRef = useRef(activeChapterId);
  readingChapterRef.current = activeChapterId;
  const speechEnabled = useSpeechFlagStore((state) => state.enabled && state.userId === user?.id);
  const [speechCover, setSpeechCover] = useState<string>();
  const speechPositionSequence = useRef(0);
  const pendingSpeechPosition = useRef<{ id: number; resolve: (value: SpeechReadingPosition) => void; reject: () => void } | null>(null);
  const speechLocationRef = useRef<{ location: SpeechLocation; reveal: boolean } | null>(null);
  const getSpeechPosition = useCallback(() => new Promise<SpeechReadingPosition>((resolve, reject) => {
    if (!readerReadyChapterRef.current || (readingModeRef.current === "paged" && readerReadyChapterRef.current !== readingChapterRef.current)) {
      reject(new Error("阅读位置尚未就绪，请稍后重试")); return;
    }
    pendingSpeechPosition.current?.reject();
    const id = ++speechPositionSequence.current;
    const timer = setTimeout(() => {
      if (pendingSpeechPosition.current?.id === id) pendingSpeechPosition.current.reject();
    }, 3000);
    pendingSpeechPosition.current = { id,
      resolve: (value) => { clearTimeout(timer); pendingSpeechPosition.current = null; resolve(value); },
      reject: () => { clearTimeout(timer); pendingSpeechPosition.current = null; reject(new Error("阅读位置尚未就绪，请稍后重试")); },
    };
    webViewRef.current?.injectJavaScript(createBookReaderSpeechPositionScript(id));
  }), []);
  useEffect(() => () => pendingSpeechPosition.current?.reject(), [activeChapterId, datasetId, itemKey]);
  function showSpeechLocation(location: SpeechLocation | null, reveal = false) {
    const pendingReveal = speechLocationRef.current?.location.chapterId === location?.chapterId && speechLocationRef.current?.reveal;
    const speech = location ? { location, reveal: reveal || Boolean(pendingReveal) } : null;
    speechLocationRef.current = speech;
    if (!speech) {
      webViewRef.current?.injectJavaScript(createBookReaderSpeechHighlightScript(null));
      return;
    }
    if (bookReadingMode === "scroll") {
      const generation = scrollGenerationRef.current;
      const apply = () => {
        if (generation !== scrollGenerationRef.current || speechLocationRef.current !== speech || !readerReadyChapterRef.current || readingModeRef.current !== "scroll") return;
        webViewRef.current?.injectJavaScript(createBookReaderSpeechHighlightScript(speech.location, speech.reveal));
        speech.reveal = false;
      };
      if (scrollChaptersRef.current.has(speech.location.chapterId)) apply();
      else if (speech.reveal) void ensureScrollChapter(speech.location.chapterId).then((value) => { if (value) apply(); });
      return;
    }
    if (speech.location.chapterId !== activeChapterId) {
      webViewRef.current?.injectJavaScript(createBookReaderSpeechHighlightScript(null));
      if (speech.reveal) chooseChapter(speech.location.chapterId);
      return;
    }
    if (chapterLoading || readerReadyChapterRef.current !== activeChapterId || chapter?.fragment.fragmentId !== activeChapterId) return;
    webViewRef.current?.injectJavaScript(createBookReaderSpeechHighlightScript(speech.location, speech.reveal));
    speech.reveal = false;
  }
  useEffect(() => {
    let active = true;
    setSpeechCover(undefined);
    if (loaded && speechEnabled) void loadMobileBookCover(loaded.book, itemKey).then((uri) => { if (active) setSpeechCover(uri); }).catch(() => undefined);
    return () => { active = false; };
  }, [loaded, itemKey, speechEnabled]);
  const loadSpeechChapter = useCallback(async (id: string) => {
    if (!loaded) throw new Error("书籍尚未加载");
    const { fragment } = scrollChaptersRef.current.get(id) ?? await loadMobileBookChapter(loaded, id, false);
    return { id, title: fragment.title, segments: mobileSpeechSegments(fragment.title, fragment.body.value, fragment.body.format) };
  }, [loaded]);
  const readingTime = useBookReadingTime(datasetId, itemKey, Boolean(chapter) && !loading && !error && !activeTool && !noteComposer && !activeAnnotationId && !expandedImageUri);
  useEffect(() => {
    noteContextRef.current = noteContext;
    setNoteComposer(undefined); setNoteDraft(""); setNoteError(""); setNoteSaving(false);
    setActiveAnnotationId(undefined); setSelection(undefined); noteRequestRef.current = null;
    return () => { if (noteContextRef.current === noteContext) noteContextRef.current = ""; };
  }, [noteContext]);

  useEffect(() => {
    let active = true;
    void Brightness.getBrightnessAsync().then((value) => { if (active) setBrightness(value); }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => () => cancelAgentRef.current?.(), []);

  useEffect(() => {
    if (!loaded || !user) {
      setOnBookshelf(undefined);
      return undefined;
    }
    let active = true;
    setOnBookshelf(undefined);
    void mobileBookshelfContains(datasetId, loaded.volume.itemId)
      .then((value) => { if (active) setOnBookshelf(value); })
      .catch(() => { if (active) setReaderNotice("书架状态暂时无法读取，点击书架按钮重试。"); });
    return () => { active = false; };
  }, [datasetId, loaded, user]);

  useEffect(() => {
    let active = true;
    const routeBook = `${datasetId}\0${itemKey}`;
    const controller = new AbortController();
    const bookChanged = aiBookRouteRef.current !== routeBook;
    aiBookRouteRef.current = routeBook;
    if (bookChanged) {
      pendingLocateRef.current = undefined;
      setDragProgress(undefined);
      setPageState(undefined);
      setChapterEntryEdge("start");
      setActiveTool(null);
      setSearchQuery("");
      setTocQuery("");
      setSearchResults([]);
      setSearching(false);
      setSearchSearched(false);
      setSearchError("");
      setReferenceHistory([]);
      cancelAgentRef.current?.();
      cancelAgentRef.current = undefined;
      setAiMessages([]);
      setAiStream("");
      setAiError("");
      setAiLoading(false);
      setConversationId(undefined);
    }
    setLoaded(undefined);
    setChapter(undefined);
    scrollGenerationRef.current += 1;
    scrollSeekRef.current += 1;
    scrollChaptersRef.current.clear();
    scrollRequestsRef.current.clear();
    readerReadyChapterRef.current = "";
    setItemLoading(true);
    setError("");
    setLegacyResume(undefined);
    void loadMobileBookItem(datasetId, itemKey, controller.signal)
      .then((value) => {
        if (!active) return;
        const savedBook = !initialChapterId && !initialAnchorId && !initialText
          ? useMobileStore.getState().recentBooks.find((candidate) => (
            candidate.datasetId === datasetId && candidate.itemKey === itemKey
          ))
          : undefined;
        const chapters = value.manifest.content.chapters ?? [];
        const legacyTarget = savedBook && !savedBook.chapterId
          ? resolveLegacyBookResume(chapters, savedBook.progress)
          : undefined;
        const firstChapter = chapters.find((candidate) => candidate.id === (initialChapterId ?? savedBook?.chapterId ?? legacyTarget?.chapterId))
          ?? chapters[0];
        if (!firstChapter) throw new Error("书籍没有可读章节");
        setLoaded(value);
        if (legacyTarget && legacyTarget.chapterId === firstChapter.id) setLegacyResume(legacyTarget);
        if (initialAnchorId || initialText) {
          pendingLocateRef.current = { chapterId: firstChapter.id, anchorId: initialAnchorId, text: initialText };
        }
        setActiveChapterId(firstChapter.id);
      })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "无法打开书籍"); })
      .finally(() => { if (active) setItemLoading(false); });
    return () => { active = false; controller.abort(); scrollGenerationRef.current += 1; };
  }, [datasetId, initialAnchorId, initialChapterId, initialText, itemKey, retryToken, user?.id, offlineIdentityVersion]);

  useEffect(() => {
    if (!loaded || !activeChapterId) { setChapterLoading(false); return; }
    // Scrolling changes the visible chapter inside the existing WebView.
    // Its document and previously loaded chapters must stay mounted.
    if (bookReadingMode === "scroll" && chapter && scrollChaptersRef.current.has(activeChapterId)) return;
    let active = true;
    const controller = new AbortController();
    setChapterLoading(true);
    setError("");
    setChapter(undefined);
    setSelection(undefined);
    void loadMobileBookChapter(loaded, activeChapterId, true, controller.signal)
      .then((value) => { if (active) { scrollChaptersRef.current.set(activeChapterId, value); setChapter(value); } })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "无法读取章节"); })
      .finally(() => { if (active) setChapterLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [activeChapterId, loaded, chapterRetryToken, bookReadingMode]);

  useEffect(() => {
    if (!loaded || !chapter || bookReadingMode === "scroll") return;
    const controller = new AbortController();
    void prefetchMobileBookChapters(loaded, activeChapterId, controller.signal);
    return () => controller.abort();
  }, [loaded, chapter, activeChapterId, bookReadingMode]);

  const chapters = loaded?.manifest.content.chapters ?? [];
  const activeIndex = Math.max(0, chapters.findIndex((candidate) => candidate.id === activeChapterId));
  const cloudAnnotations = useBookAnnotations({
    userId: loaded ? user?.id ?? null : null,
    contentId: `${loaded?.manifest.datasetId ?? datasetId}:${loaded?.manifest.itemId ?? loaded?.volume.itemId ?? itemKey}`,
    sectionIds: chapters.map((entry) => entry.id), activeSectionId: activeChapterId,
    loadAll: activeTool === "notes" || activeTool === "progress",
  });
  const localBookAnnotations = useMemo(() => annotations.filter((annotation) => (
    annotation.datasetId === datasetId && annotation.itemKey === itemKey && (annotation.ownerId ?? null) === (user?.id ?? null)
  )), [annotations, datasetId, itemKey, user?.id]);
  const legacyNoteCount = user ? annotations.filter((annotation) => annotation.ownerId == null && annotation.datasetId === datasetId && annotation.itemKey === itemKey).length : 0;
  const asReaderAnnotation = (thread: AnnotationThread): ReaderAnnotation => ({
    id: thread.id, ownerId: user?.id, datasetId, itemKey, chapterId: thread.sectionId,
    chapterTitle: chapters.find((entry) => entry.id === thread.sectionId)?.title ?? "正文",
    start: thread.startOffset ?? -1, end: thread.endOffset ?? -1, quote: thread.quote,
    prefix: thread.prefix, suffix: thread.suffix, createdAt: Date.parse(thread.createdAt), thread,
  });
  const bookAnnotations: ReaderAnnotation[] = useMemo(() => [
    ...localBookAnnotations, ...cloudAnnotations.threads.map(asReaderAnnotation),
  ], [localBookAnnotations, cloudAnnotations.threads, loaded, user?.id]);
  const bookNotes = [...localBookAnnotations, ...cloudAnnotations.notes.map(asReaderAnnotation)] as ReaderAnnotation[];
  const activeCloudThread = cloudAnnotations.threads.find((thread) => thread.id === activeAnnotationId);
  const chapterAnnotations = useMemo(() => bookAnnotations.filter((annotation) => annotation.chapterId === activeChapterId), [activeChapterId, bookAnnotations]);
  const bookAnnotationsRef = useRef(bookAnnotations);
  bookAnnotationsRef.current = bookAnnotations;
  const chapterPageProgress = pageState
    ? pageState.paged && pageState.pageCount > 0
      ? pageState.pageEnd / pageState.pageCount
      : pageState.scrollProgress
    : 0;
  const progress = bookProgressPercent(chapters, activeChapterId, chapterPageProgress * 100);
  const previewProgress = dragProgress ?? progress;
  const previewLocation = bookProgressLocation(chapters, previewProgress);
  const previewChapter = chapters.find((entry) => entry.id === previewLocation?.chapterId);
  const remainingMinutes = estimatedReadingMinutes(chapters.reduce((sum, entry) => sum + (Number.isFinite(entry.characterCount) ? Math.max(0, entry.characterCount) : 0), 0), previewProgress);
  const tocEntries = useMemo(() => bookTocEntries(loaded?.manifest.content.toc ?? [], chapters), [loaded]);
  const exactTocIndex = pageState?.anchorId ? tocEntries.findIndex((entry) => entry.chapterId === activeChapterId && entry.anchorId === pageState.anchorId) : -1;
  const currentTocIndex = exactTocIndex >= 0 ? exactTocIndex : Math.max(0, tocEntries.findIndex((entry) => entry.chapterId === activeChapterId));
  const filteredTocEntries = useMemo(() => {
    const query = tocQuery.normalize("NFKC").trim().toLocaleLowerCase();
    return query ? tocEntries.filter((entry) => entry.title.normalize("NFKC").toLocaleLowerCase().includes(query)) : tocEntries;
  }, [tocEntries, tocQuery]);
  useEffect(() => {
    if (activeTool !== "toc" || !tocEntries.length || tocQuery) return;
    const timer = setTimeout(() => tocListRef.current?.scrollToIndex({ index: currentTocIndex, viewPosition: .4, animated: false }), 80);
    return () => clearTimeout(timer);
  }, [activeTool, currentTocIndex, tocEntries.length, tocQuery]);
  const document = useMemo(() => chapter ? createBookDocument({
    fragment: chapter.fragment,
    assetUrls: chapter.assetUrls,
    textScale,
    lineHeight: bookLineHeight,
    firstLineIndent: bookFirstLineIndent,
    eInk: IS_EINK_RELEASE,
    readingMode: bookReadingMode,
    paperColor: bookPaperColor,
  }) : "", [bookFirstLineIndent, bookLineHeight, bookPaperColor, bookReadingMode, chapter, textScale]);
  const readerBridgeScript = useMemo(() => createBookReaderBridgeScript(
    chapterEntryEdge,
    leftTapNext,
    (bookReadingMode === "scroll" ? bookAnnotations : chapterAnnotations).map(({ id, chapterId, start, end, quote, prefix, suffix }) => ({ id, chapterId, start, end, quote, prefix, suffix })),
    !initialChapterId && !initialAnchorId && !initialText && recentBook?.chapterId === activeChapterId
      ? recentBook.spreadIndex
      : undefined,
    !initialChapterId && !initialAnchorId && !initialText && recentBook?.chapterId === activeChapterId
      ? recentBook.scrollProgress
      : undefined,
    !initialChapterId && !initialAnchorId && !initialText && legacyResume?.chapterId === activeChapterId
      ? legacyResume.chapterProgress
      : undefined,
    {
      tocAnchorIds: tocEntries.filter((entry) => entry.chapterId === activeChapterId && entry.anchorId).map((entry) => entry.anchorId!),
      hasNext: activeIndex < chapters.length - 1, hasPrevious: activeIndex > 0, eInk: IS_EINK_RELEASE,
      initialChapterId: chapter?.fragment.fragmentId,
      chapters: chapters.map((entry) => ({ id: entry.id, title: entry.title, tocAnchorIds: tocEntries.filter((toc) => toc.chapterId === entry.id && toc.anchorId).map((toc) => toc.anchorId!) })),
    },
  ), [activeChapterId, activeIndex, chapters, tocEntries, chapter, bookReadingMode, bookAnnotations, chapterAnnotations, chapterEntryEdge, initialAnchorId, initialChapterId, initialText, leftTapNext, legacyResume, recentBook?.chapterId, recentBook?.scrollProgress, recentBook?.spreadIndex]);

  useEffect(() => {
    for (const annotation of bookReadingMode === "scroll" ? bookAnnotations : chapterAnnotations) {
      webViewRef.current?.injectJavaScript(createBookReaderApplyAnnotationScript(annotation));
    }
  }, [bookAnnotations, chapterAnnotations, bookReadingMode, chapter]);

  function insertScrollChapter(value: LoadedMobileBookChapter) {
    const id = value.fragment.fragmentId;
    webViewRef.current?.injectJavaScript(createBookReaderInsertChapterScript(
      id, createBookChapterMarkup(value.fragment, value.assetUrls),
      bookAnnotationsRef.current.filter((annotation) => annotation.chapterId === id),
    ));
  }

  async function ensureScrollChapter(chapterId: string): Promise<LoadedMobileBookChapter | undefined> {
    if (!loaded || !chapters.some((entry) => entry.id === chapterId)) return undefined;
    const cached = scrollChaptersRef.current.get(chapterId);
    if (cached) { insertScrollChapter(cached); return cached; }
    const pending = scrollRequestsRef.current.get(chapterId);
    if (pending) return pending;
    const generation = scrollGenerationRef.current;
    const request = loadMobileBookChapter(loaded, chapterId, true).then((value) => {
      if (generation !== scrollGenerationRef.current) return undefined;
      scrollChaptersRef.current.set(chapterId, value);
      if (readingModeRef.current === "scroll") insertScrollChapter(value);
      return value;
    }).catch(() => {
      if (generation === scrollGenerationRef.current && readingModeRef.current === "scroll") webViewRef.current?.injectJavaScript(createBookReaderChapterFailedScript(chapterId));
      return undefined;
    }).finally(() => {
      if (generation === scrollGenerationRef.current) scrollRequestsRef.current.delete(chapterId);
    });
    scrollRequestsRef.current.set(chapterId, request);
    return request;
  }

  function applyLocate(pending: PendingLocate) {
    const scopedChapter = bookReadingMode === "scroll" ? pending.chapterId : undefined;
    if (pending.text) webViewRef.current?.injectJavaScript(createBookReaderLocateTextScript(pending.text, scopedChapter));
    else if (pending.anchorId) webViewRef.current?.injectJavaScript(createBookReaderRevealAnchorScript(pending.anchorId, scopedChapter));
    else if (typeof pending.spreadIndex === "number" && bookReadingMode === "paged") webViewRef.current?.injectJavaScript(createBookReaderGoToSpreadScript(pending.spreadIndex));
    else webViewRef.current?.injectJavaScript(createBookReaderGoToChapterProgressScript(pending.chapterProgress ?? pending.scrollProgress ?? 0, scopedChapter));
  }

  function chooseChapter(chapterId: string, entryEdge: BookChapterEdge = "start", revealChrome = true) {
    readingProgress.flush();
    setActiveTool(null);
    if (revealChrome) setChromeVisible(true);
    clearSelection();
    const seek = ++scrollSeekRef.current;
    if (bookReadingMode === "scroll" && chapter) {
      const pending = pendingLocateRef.current?.chapterId === chapterId ? pendingLocateRef.current : { chapterId, chapterProgress: entryEdge === "end" ? 1 : 0 };
      pendingLocateRef.current = undefined;
      const generation = scrollGenerationRef.current;
      void ensureScrollChapter(chapterId).then((value) => {
        if (generation !== scrollGenerationRef.current || seek !== scrollSeekRef.current || readingModeRef.current !== "scroll") return;
        if (value) {
          if (readerReadyChapterRef.current) applyLocate(pending);
          else pendingLocateRef.current = pending;
        }
        else setReaderNotice("章节暂时无法读取，请重试。");
      });
      return;
    }
    setPageState(undefined);
    setChapterEntryEdge(entryEdge);
    if (chapterId === activeChapterId) setChapterRetryToken((value) => value + 1);
    setActiveChapterId(chapterId);
  }

  function clearSelection() {
    setSelection(undefined);
    webViewRef.current?.injectJavaScript(createBookReaderClearSelectionScript());
  }

  function handleReaderMessage(event: WebViewMessageEvent) {
    const message = parseBookReaderMessage(event.nativeEvent.data);
    if (!message) return;
    if (message.type !== "reader-ready" && message.type !== "reader-speech-position" && message.type !== "reader-chapter-request") readingTime.recordActivity();
    if (message.type === "reader-ready") {
      if (message.chapterId === chapter?.fragment.fragmentId) handleReaderReady();
      return;
    }
    if (message.type === "reader-chapter-request") { if (bookReadingMode === "scroll") void ensureScrollChapter(message.chapterId); return; }
    if (message.type === "reader-speech-position") {
      if (pendingSpeechPosition.current?.id === message.requestId) pendingSpeechPosition.current.resolve(message.position);
      return;
    }
    if (message.type === "reader-selection-clear") { setSelection(undefined); return; }
    if (message.type === "reader-selection") {
      setSelection(message);
      setActiveTool(null);
      setChromeVisible(false);
      if (!selection || selection.start !== message.start || selection.end !== message.end) void selectionHaptic(hapticsEnabled);
      return;
    }
    if (message.type === "reader-annotation") {
      const annotation = bookAnnotations.find((candidate) => candidate.id === message.id);
      if (annotation) {
        setActiveAnnotationId(annotation.id);
        if (annotation.thread) { openDiscussion(annotation.thread); return; }
        setNoteComposer({ annotationId: annotation.id, quote: annotation.quote });
        setNoteDraft(annotation.note ?? "");
        setNoteError(""); setNoteVisibility("private");
        setActiveTool("notes");
        setChromeVisible(true);
      }
      return;
    }
    if (message.type === "reader-internal-link") {
      if (!chapters.some((candidate) => candidate.id === message.chapterId)) return;
      const sourceId = message.sourceChapterId && chapters.some((candidate) => candidate.id === message.sourceChapterId) ? message.sourceChapterId : activeChapterId;
      setReferenceHistory((history) => [...history, { chapterId: sourceId, spreadIndex: pageState?.paged ? pageState.spreadIndex : undefined, scrollProgress: pageState?.paged ? undefined : message.sourceProgress ?? pageState?.scrollProgress }]);
      pendingLocateRef.current = { chapterId: message.chapterId, anchorId: message.anchorId };
      chooseChapter(message.chapterId);
      return;
    }
    if (message.type === "reader-image") {
      const uri = (message.chapterId ? scrollChaptersRef.current.get(message.chapterId) : chapter)?.assetUrls[message.assetId];
      if (uri) setExpandedImageUri(uri);
      return;
    }
    if (message.type === "reader-cross-reference") {
      if (!loaded) return;
      setReaderNotice("");
      void resolveMobileAnnotationReference(loaded, message)
        .then((target) => navigation.push("BookReader", {
          datasetId,
          itemKey: target.itemKey,
          title: target.itemTitle,
          bookTitle: loaded.book.title,
          initialChapterId: target.chapterId,
          initialAnchorId: target.annotationId,
          returnToReference: true,
        }))
        .catch((reason: unknown) => setReaderNotice(reason instanceof Error ? reason.message : String(reason)));
      return;
    }
    if (message.type === "reader-tap") {
      setActiveTool(null);
      setChromeVisible((visible) => !visible);
      return;
    }
    if (message.type === "reader-page") {
      const visibleChapterId = !message.paged && message.chapterId && scrollChaptersRef.current.has(message.chapterId) ? message.chapterId : activeChapterId;
      if (visibleChapterId !== activeChapterId) setActiveChapterId(visibleChapterId);
      setPageState(message);
      if (legacyResume?.chapterId === visibleChapterId) setLegacyResume(undefined);
      if (chapterEntryEdge === "end") setChapterEntryEdge("start");
      const chapterFraction = message.paged && message.pageCount > 0
        ? message.pageEnd / message.pageCount
        : message.scrollProgress;
      const nextProgress = bookProgressPercent(chapters, visibleChapterId, chapterFraction * 100);
      readingProgress.schedule({
        datasetId,
        itemKey,
        title,
        subtitle: bookTitle,
        progress: nextProgress,
        chapterId: visibleChapterId,
        spreadIndex: message.paged ? message.spreadIndex : undefined,
        scrollProgress: message.paged ? undefined : message.scrollProgress,
      });
      return;
    }
    if (message.direction === "previous" && activeIndex > 0) chooseChapter(chapters[activeIndex - 1]!.id, "end", false);
    else if (message.direction === "next" && activeIndex < chapters.length - 1) chooseChapter(chapters[activeIndex + 1]!.id, "start", false);
  }

  function resetPage() {
    readingProgress.flush();
    if (bookReadingMode === "scroll" && chapter) {
      pendingLocateRef.current = { chapterId: activeChapterId, scrollProgress: pageState?.scrollProgress ?? 0 };
      const visible = scrollChaptersRef.current.get(activeChapterId);
      if (visible) setChapter(visible);
    }
    setActiveTool(null);
    setChapterEntryEdge("start");
    setPageState(undefined);
  }
  function chooseTextScale(value: 0.9 | 1 | 1.12) { resetPage(); setTextScale(value); void selectionHaptic(hapticsEnabled); }
  function chooseLineHeight(value: 1.75 | 1.95 | 2.15) { resetPage(); setBookLineHeight(value); void selectionHaptic(hapticsEnabled); }
  function chooseFirstLineIndent(value: boolean) { resetPage(); setBookFirstLineIndent(value); void selectionHaptic(hapticsEnabled); }
  function chooseReadingMode(value: BookReadingMode) { resetPage(); setBookReadingMode(value); void selectionHaptic(hapticsEnabled); }
  function choosePaperColor(value: BookPaperColor) { resetPage(); setBookPaperColor(value); void selectionHaptic(hapticsEnabled); }
  function toggleTool(tool: ReaderTool) {
    setChromeVisible(true);
    setNoteComposer(undefined);
    setDragProgress(undefined);
    setActiveTool((current) => current === tool ? null : tool);
    void selectionHaptic(hapticsEnabled);
  }
  function goToBookProgress(value: number) {
    const target = bookProgressLocation(chapters, value);
    setDragProgress(undefined);
    if (!target) return;
    if (target.chapterId === activeChapterId) {
      webViewRef.current?.injectJavaScript(createBookReaderGoToChapterProgressScript(target.chapterProgress / 100, bookReadingMode === "scroll" ? target.chapterId : undefined));
    } else {
      pendingLocateRef.current = { chapterId: target.chapterId, chapterProgress: target.chapterProgress / 100 };
      chooseProgressChapter(target.chapterId);
    }
    void selectionHaptic(hapticsEnabled);
  }
  function chooseProgressChapter(chapterId: string, entryEdge: BookChapterEdge = "start") {
    chooseChapter(chapterId, entryEdge);
    setActiveTool("progress");
  }
  function chooseTocEntry(entry: BookTocEntry) {
    if (!entry.chapterId) return;
    if (entry.chapterId === activeChapterId) {
      setActiveTool(null);
      webViewRef.current?.injectJavaScript(entry.anchorId ? createBookReaderRevealAnchorScript(entry.anchorId, entry.chapterId) : createBookReaderGoToChapterProgressScript(0, entry.chapterId));
    } else {
      pendingLocateRef.current = { chapterId: entry.chapterId, anchorId: entry.anchorId };
      chooseChapter(entry.chapterId);
    }
  }
  function locateText(chapterId: string, text: string) {
    const target = text.trim();
    if (!target) return;
    setActiveTool(null);
    setChromeVisible(false);
    if (chapterId === activeChapterId && chapter) {
      webViewRef.current?.injectJavaScript(createBookReaderLocateTextScript(target, chapterId));
      return;
    }
    pendingLocateRef.current = { chapterId, text: target };
    chooseChapter(chapterId);
  }
  function handleReaderReady() {
    if (!chapter || (bookReadingMode === "paged" && chapter.fragment.fragmentId !== activeChapterId)) return;
    const documentId = chapter.fragment.fragmentId;
    if (readerReadyChapterRef.current === documentId) return;
    readerReadyChapterRef.current = documentId;
    if (bookReadingMode === "scroll") for (const value of scrollChaptersRef.current.values()) if (value.fragment.fragmentId !== documentId) insertScrollChapter(value);
    webViewRef.current?.injectJavaScript(createBookReaderMeasureScript());
    const generation = scrollGenerationRef.current;
    setTimeout(() => {
      const speech = speechLocationRef.current;
      if (generation !== scrollGenerationRef.current || readerReadyChapterRef.current !== documentId || !speech) return;
      if (readingModeRef.current === "scroll" || speech.location.chapterId === readingChapterRef.current) showSpeechLocation(speech.location, speech.reveal);
    }, 160);
    const pending = pendingLocateRef.current;
    if (!pending || (bookReadingMode === "paged" && pending.chapterId !== activeChapterId)) return;
    pendingLocateRef.current = undefined;
    setTimeout(() => {
      if (readerReadyChapterRef.current !== documentId) return;
      applyLocate(pending);
    }, 80);
  }
  function handleBack() {
    const previous = referenceHistory[referenceHistory.length - 1];
    if (!previous) {
      navigation.goBack();
      return;
    }
    setReferenceHistory((history) => history.slice(0, -1));
    pendingLocateRef.current = previous;
    chooseChapter(previous.chapterId);
  }
  async function openAgentReference(reference: MobileBookAgentReference) {
    if (!loaded || !reference.targetId) return;
    setReaderNotice("");
    if (!reference.itemId || reference.itemId === loaded.volume.itemId) {
      if (reference.anchorId) {
        if (reference.targetId === activeChapterId && chapter) {
          webViewRef.current?.injectJavaScript(createBookReaderRevealAnchorScript(reference.anchorId, reference.targetId));
          setActiveTool(null);
        } else {
          pendingLocateRef.current = { chapterId: reference.targetId, anchorId: reference.anchorId };
          chooseChapter(reference.targetId);
        }
      } else if (reference.excerpt) locateText(reference.targetId, reference.excerpt);
      else chooseChapter(reference.targetId);
      return;
    }
    try {
      const volumes = await loadMobileBookVolumes(loaded.book);
      const volume = volumes.find((candidate) => candidate.itemId === reference.itemId);
      if (!volume) throw new Error("找不到引用所在分卷");
      navigation.push("BookReader", {
        datasetId,
        itemKey: volume.itemKey,
        title: volume.title,
        bookTitle: loaded.book.title,
        initialChapterId: reference.targetId,
        initialAnchorId: reference.anchorId,
        initialText: reference.excerpt,
        returnToReference: true,
      });
    } catch (reason) {
      setReaderNotice(reason instanceof Error ? reason.message : String(reason));
    }
  }
  function createAnnotation(selected: BookReaderSelectionMessage, note?: string): BookAnnotation {
    const created = addBookAnnotation({
      ownerId: user?.id ?? null,
      datasetId,
      itemKey,
      chapterId: selected.chapterId ?? activeChapterId,
      chapterTitle: chapters.find((entry) => entry.id === (selected.chapterId ?? activeChapterId))?.title ?? "正文",
      start: selected.start,
      end: selected.end,
      quote: selected.text,
      prefix: selected.prefix, suffix: selected.suffix,
      note: note?.trim() || undefined,
    });
    webViewRef.current?.injectJavaScript(createBookReaderApplyAnnotationScript(created));
    clearSelection();
    return created;
  }
  async function saveCloudAnnotation(selected: BookReaderSelectionMessage, note?: string, visibility: AnnotationVisibility = "public") {
    const chapterId = selected.chapterId ?? activeChapterId;
    const contentDatasetId = loaded?.manifest.datasetId ?? datasetId;
    const contentItemId = loaded?.manifest.itemId ?? loaded?.volume.itemId ?? itemKey;
    return cloudAnnotations.create({
      contentType: "book", contentId: `${contentDatasetId}:${contentItemId}`, sectionId: chapterId,
      contentTitle: `${title} · ${chapters.find((entry) => entry.id === chapterId)?.title ?? "正文"}`,
      contentUrl: `/book/${encodeURIComponent(datasetId)}/${encodeURIComponent(itemKey)}?${new URLSearchParams({ chapter: chapterId })}`,
    }, { quote: selected.text, prefix: selected.prefix ?? "", suffix: selected.suffix ?? "", startOffset: selected.start, endOffset: selected.end }, note, visibility);
  }
  async function underlineSelection() {
    if (!selection || noteRequestRef.current) return;
    const context = noteContext;
    noteRequestRef.current = context;
    try {
      if (user) await saveCloudAnnotation(selection);
      else createAnnotation(selection);
      if (noteContextRef.current !== context) return;
      clearSelection();
      void selectionHaptic(hapticsEnabled);
    } catch (reason) { if (noteContextRef.current === context) setReaderNotice(annotationError(reason)); }
    finally { if (noteRequestRef.current === context) noteRequestRef.current = null; }
  }
  function composeSelectionNote() {
    if (!selection) return;
    setNoteComposer({ selection, quote: selection.text });
    setNoteDraft("");
    setNoteVisibility(user ? "public" : "private"); setNoteError("");
    clearSelection();
  }
  async function saveNote() {
    if (!noteComposer || !noteDraft.trim() || noteDraft.length > 2000 || noteRequestRef.current) return;
    const context = noteContext;
    noteRequestRef.current = context; setNoteSaving(true); setNoteError("");
    try {
      if (noteComposer.annotationId) {
        const local = localBookAnnotations.find((entry) => entry.id === noteComposer.annotationId);
        if (!local) throw new Error("登录状态已变化，请重试");
        if (user) {
          await saveCloudAnnotation({ type: "reader-selection", chapterId: local.chapterId, text: local.quote, start: local.start, end: local.end, prefix: local.prefix, suffix: local.suffix }, noteDraft, noteVisibility);
          if (noteContextRef.current !== context) return;
          removeBookAnnotation(local.id);
          webViewRef.current?.injectJavaScript(createBookReaderRemoveAnnotationScript(local.id));
        } else updateBookAnnotationNote(noteComposer.annotationId, noteDraft);
      }
      else if (noteComposer.selection) {
        if (user) await saveCloudAnnotation(noteComposer.selection, noteDraft, noteVisibility);
        else createAnnotation(noteComposer.selection, noteDraft);
      }
      if (noteContextRef.current !== context) return;
      setNoteComposer(undefined); setNoteDraft(""); setActiveAnnotationId(undefined);
      setActiveTool("notes"); setChromeVisible(true);
      void selectionHaptic(hapticsEnabled);
    } catch (reason) { if (noteContextRef.current === context) setNoteError(annotationError(reason)); }
    finally {
      if (noteRequestRef.current === context) { noteRequestRef.current = null; if (noteContextRef.current === context) setNoteSaving(false); }
    }
  }
  function openDiscussion(thread: AnnotationThread) {
    setActiveAnnotationId(thread.id);
    const context = noteContext;
    void cloudAnnotations.open(thread).catch((reason) => { if (noteContextRef.current === context) setReaderNotice(annotationError(reason)); });
  }
  function saveNoteLocally() {
    if (!noteComposer || !noteDraft.trim() || noteDraft.length > 2000 || noteRequestRef.current || noteContextRef.current !== noteContext) return;
    if (noteComposer.annotationId) {
      if (!localBookAnnotations.some((entry) => entry.id === noteComposer.annotationId)) return;
      updateBookAnnotationNote(noteComposer.annotationId, noteDraft);
    } else if (noteComposer.selection) createAnnotation(noteComposer.selection, noteDraft);
    setNoteComposer(undefined); setNoteDraft(""); setNoteError(""); setActiveAnnotationId(undefined);
    setActiveTool("notes"); setChromeVisible(true); setReaderNotice("已保存到本机");
  }
  function deleteAnnotation(annotation: BookAnnotation) {
    removeBookAnnotation(annotation.id);
    if (bookReadingMode === "scroll" || annotation.chapterId === activeChapterId) webViewRef.current?.injectJavaScript(createBookReaderRemoveAnnotationScript(annotation.id));
    if (activeAnnotationId === annotation.id) setActiveAnnotationId(undefined);
    if (noteComposer?.annotationId === annotation.id) setNoteComposer(undefined);
    void selectionHaptic(hapticsEnabled);
  }
  async function submitSearch() {
    const query = searchQuery.trim();
    if (!loaded || !query || searching) return;
    const requestBook = aiBookRouteRef.current;
    setSearching(true);
    setSearchError("");
    try {
      const results = await searchMobileBook(loaded, query);
      if (requestBook !== aiBookRouteRef.current) return;
      setSearchResults(results);
      setSearchSearched(true);
    } catch (reason) {
      if (requestBook === aiBookRouteRef.current) setSearchError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (requestBook === aiBookRouteRef.current) setSearching(false);
    }
  }
  function clearAiConversation() {
    setConversationId(undefined);
    setAiMessages([]);
    setAiStream("");
    setAiError("");
  }
  function startNewAiConversation() {
    if (aiLoading) return;
    clearAiConversation();
  }
  function askAi(question: string) {
    const value = question.trim();
    if (!loaded || !value || aiLoading) return;
    setAiMessages((current) => [...current, { role: "user", content: value }]);
    setAiInput("");
    setAiError("");
    setAiStream("");
    setAiLoading(true);
    let answer = "";
    cancelAgentRef.current = askMobileBookAgent({
      datasetId,
      itemId: loaded.volume.itemId,
      manifestObject: loaded.manifestObject,
      question: value,
      conversationId,
      history: aiMessages,
    }, (chunk) => {
      answer += chunk;
      setAiStream(answer);
    }, (nextConversationId, references) => {
      if (answer) setAiMessages((current) => [...current, { role: "assistant", content: answer, references }]);
      setConversationId(nextConversationId);
      setAiStream("");
      setAiLoading(false);
    }, (message) => {
      setAiError(message);
      setAiStream("");
      setAiLoading(false);
    });
  }
  function explainSelection() {
    if (!selection) return;
    const quote = selection.text;
    clearSelection();
    setActiveTool("ai");
    setChromeVisible(true);
    askAi(`请解释这段话：\n\n“${quote}”`);
  }

  async function toggleBookshelf() {
    if (!user) { navigation.navigate("Account"); return; }
    if (!loaded || bookshelfBusy) return;
    setBookshelfBusy(true);
    setReaderNotice("");
    try {
      const next = !(onBookshelf ?? await mobileBookshelfContains(datasetId, loaded.volume.itemId));
      await setMobileBookshelf({
        datasetId,
        itemId: loaded.volume.itemId,
        title: loaded.volume.title,
        added: next,
      });
      setOnBookshelf(next);
      setReaderNotice(next ? "已加入我的书架" : "已移出我的书架");
    } catch (reason) {
      setReaderNotice(reason instanceof Error ? reason.message : "书架状态更新失败");
    } finally {
      setBookshelfBusy(false);
    }
  }

  const sheetBottom = insets.bottom + 64;
  return (
    <SafeAreaView edges={["top", "bottom"]} style={[styles.safe, { backgroundColor: theme.paper }]}>
      <ReaderEnvironment />
      <View onTouchStart={readingTime.recordActivity} onLayout={(event) => setReaderFrame(event.nativeEvent.layout)} style={[styles.reader, { backgroundColor: theme.paper }]}>
        {chapter && (bookReadingMode === "scroll" || chapter.fragment.fragmentId === activeChapterId) ? (
          <BookReaderWebView
            ref={webViewRef}
            key={`${chapter.fragment.fragmentId}:${chapterRetryToken}:${textScale}:${bookLineHeight}:${bookFirstLineIndent}:${bookReadingMode}:${bookPaperColor}`}
            html={document}
            bootstrapScript={readerBridgeScript}
            originWhitelist={["about:blank", "data:*"]}
            javaScriptEnabled
            menuItems={[]}
            domStorageEnabled={false}
            cacheEnabled={false}
            onLoadStart={() => { readerReadyChapterRef.current = ""; pendingSpeechPosition.current?.reject(); }}
            onInitializationError={() => { setChapterLoading(false); setError("阅读页面未能就绪，请重新加载"); }}
            onError={() => { setChapterLoading(false); setError("章节显示失败，请重新加载"); }}
            onRenderProcessGone={() => { setChapterLoading(false); setError("阅读页面已被系统回收，请重新加载"); }}
            onContentProcessDidTerminate={() => { setChapterLoading(false); setError("阅读页面已被系统回收，请重新加载"); }}
            onMessage={handleReaderMessage}
            onShouldStartLoadWithRequest={(request) => request.url === "about:blank" || request.url.startsWith("data:") || request.url.startsWith("#")}
            setSupportMultipleWindows={false}
            allowsBackForwardNavigationGestures={false}
            scrollEnabled={bookReadingMode === "scroll"}
            bounces={bookReadingMode === "scroll" && !IS_EINK_RELEASE}
            overScrollMode={bookReadingMode === "paged" || IS_EINK_RELEASE ? "never" : "always"}
            showsVerticalScrollIndicator={bookReadingMode === "scroll" && !IS_EINK_RELEASE}
            style={{ backgroundColor: theme.paper }}
            containerStyle={{ backgroundColor: theme.paper }}
          />
        ) : null}
        {loading ? <View pointerEvents="none" style={[styles.center, { backgroundColor: theme.paper }]}>{IS_EINK_RELEASE ? null : <ActivityIndicator color={theme.red} />}<Text style={[styles.status, { color: theme.muted, fontFamily: theme.sans }]}>正在读取章节</Text></View> : null}
        {!loading && error ? <View style={[styles.center, { backgroundColor: theme.paper }]}><Text accessibilityRole="alert" style={[styles.error, { color: theme.ink, fontFamily: theme.serif }]}>{error}</Text><Pressable onPress={retryReading} style={[styles.retry, { borderColor: theme.red }]}><Text style={[styles.retryText, { color: theme.red, fontFamily: theme.sans }]}>重新加载</Text></Pressable></View> : null}
      </View>

      {chromeVisible && !noteComposer && !activeCloudThread ? <>
        <View style={[styles.header, { top: insets.top, borderBottomColor: theme.ruleDark, backgroundColor: theme.paper }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={referenceHistory.length || returnToReference ? "返回原文" : "返回书籍"} hitSlop={10} onPress={handleBack} style={[styles.iconButton, referenceHistory.length || returnToReference ? styles.referenceBack : null]}><Ionicons name="chevron-back" size={24} color={theme.ink} />{referenceHistory.length || returnToReference ? <Text style={[styles.referenceBackText, { color: theme.ink, fontFamily: theme.sans }]}>原文</Text> : null}</Pressable>
          <View style={styles.headerCopy}><Text numberOfLines={1} style={[styles.bookTitle, { color: theme.ink, fontFamily: theme.serif }]}>{title}</Text><Text numberOfLines={1} style={[styles.chapterTitle, { color: theme.muted, fontFamily: theme.sans }]}>{chapters[activeIndex]?.title ?? bookTitle}</Text></View>
          <View><BookshelfButton added={onBookshelf} busy={bookshelfBusy} disabled={!loaded} onPress={() => void toggleBookshelf()} theme={theme} /></View>
        </View>

        {activeTool === "toc" || activeTool === "search" ? <ReaderNavigationSheet tab={activeTool} onTabChange={setActiveTool} onClose={() => setActiveTool(null)} top={insets.top + 64} bottom={sheetBottom} theme={theme}>
          {activeTool === "toc" ? <>
          <View style={{ paddingHorizontal: 20, paddingBottom: 12 }}><TextInput accessibilityLabel="搜索目录" value={tocQuery} onChangeText={setTocQuery} placeholder="筛选目录" placeholderTextColor={theme.muted} style={[styles.searchInput, { color: theme.ink, borderBottomColor: theme.rule, borderBottomWidth: 1, fontFamily: theme.serif }]} /></View>
          {filteredTocEntries.length === 0 ? <PanelStatus label="没有匹配的目录项" theme={theme} /> : null}
          <FlatList ref={tocListRef} data={filteredTocEntries} keyExtractor={(item) => item.id} initialScrollIndex={!tocQuery && tocEntries.length ? currentTocIndex : undefined} keyboardShouldPersistTaps="handled" renderItem={({ item }) => {
            const selected = item.id === tocEntries[currentTocIndex]?.id && item.chapterId === activeChapterId;
            return <Pressable accessibilityRole="button" accessibilityState={{ selected, disabled: !item.chapterId }} disabled={!item.chapterId} onPress={() => chooseTocEntry(item)} style={[styles.chapterRow, { borderBottomColor: theme.rule, paddingLeft: 12 + Math.min(item.depth, 5) * 18, backgroundColor: selected ? theme.paperSoft : theme.paper }]}>
              <View style={styles.chapterCopy}><Text numberOfLines={2} style={[styles.chapterRowTitle, { color: selected ? theme.red : item.chapterId ? theme.ink : theme.muted, fontWeight: item.depth === 0 ? "700" : "400", fontFamily: theme.serif }]}>{item.title}</Text></View>
              {selected ? <View style={styles.currentChapterMark}><Ionicons name="book-outline" size={14} color={theme.red} /><Text style={[styles.currentChapter, { color: theme.red, fontFamily: theme.sans }]}>当前读到</Text></View> : null}
            </Pressable>;
          }} getItemLayout={(_, index) => ({ length: 68, offset: 68 * index, index })} overScrollMode={IS_EINK_RELEASE ? "never" : "always"} />
          </> : <>
          <View style={{ paddingHorizontal: 20, paddingBottom: 12 }}><View style={[styles.searchBox, { borderBottomColor: theme.ruleDark }]}><Ionicons name="search-outline" size={18} color={theme.muted} /><TextInput value={searchQuery} onChangeText={setSearchQuery} onSubmitEditing={() => void submitSearch()} placeholder="搜索正文" placeholderTextColor={theme.muted} returnKeyType="search" style={[styles.searchInput, { color: theme.ink, fontFamily: theme.serif }]} /><Pressable disabled={!searchQuery.trim() || searching} onPress={() => void submitSearch()} hitSlop={8}><Text style={[styles.searchSubmit, { color: theme.red, opacity: !searchQuery.trim() || searching ? 0.35 : 1, fontFamily: theme.sans }]}>搜索</Text></Pressable></View></View>
          {searching ? <PanelStatus label="正在搜索本书" theme={theme} loading /> : null}
          {searchError ? <PanelError message={searchError} theme={theme} /> : null}
          {!searching && searchSearched && searchResults.length === 0 ? <PanelStatus label={`本书没有找到“${searchQuery.trim()}”`} theme={theme} /> : null}
          <FlatList data={searchResults} keyExtractor={(item, index) => `${item.chapterId}:${index}`} keyboardDismissMode="on-drag" renderItem={({ item }) => <Pressable onPress={() => locateText(item.chapterId, item.match)} style={[styles.resultRow, { borderBottomColor: theme.rule }]}><Text style={[styles.resultTitle, { color: theme.red, fontFamily: theme.serif }]}>{item.chapterTitle}</Text><Text style={[styles.resultExcerpt, { color: theme.muted, fontFamily: theme.serif }]}>{item.leadingEllipsis ? "…" : ""}{item.before}<Text style={{ color: theme.ink, fontWeight: "900" }}>{item.match}</Text>{item.after}{item.trailingEllipsis ? "…" : ""}</Text></Pressable>} />
          </>}
        </ReaderNavigationSheet> : null}

        {activeTool === "ai" ? <ReaderNavigationSheet onClose={() => setActiveTool(null)} top={insets.top + 64} bottom={sheetBottom} theme={theme}>
          <AiPanelHeader
            title={title}
            disabled={aiLoading}
            onNewConversation={startNewAiConversation}
            theme={theme}
          />
          <>
            <ScrollView style={styles.aiHistory} contentContainerStyle={styles.aiHistoryContent} keyboardDismissMode="on-drag">
              {aiMessages.length === 0 && !aiLoading ? <View style={[styles.aiEmpty, { borderLeftColor: theme.red }]}><Text style={[styles.aiEmptyTitle, { color: theme.ink, fontFamily: theme.serif }]}>从这本书开始问</Text><Text style={[styles.aiEmptyText, { color: theme.muted, fontFamily: theme.sans }]}>回答会引用原文，并可继续追问。</Text></View> : null}
              {aiMessages.map((message, index) => <View key={`${message.role}:${index}`} style={[styles.aiMessage, message.role === "user" ? styles.aiUser : styles.aiAssistant, { borderColor: theme.red }]}><Text style={[styles.aiMessageText, { color: theme.ink, fontFamily: theme.serif }]}>{message.content}</Text>{message.references?.some((reference) => reference.targetId) ? <View style={styles.aiReferences}>{message.references.filter((reference) => reference.targetId).slice(0, 6).map((reference, referenceIndex) => <Pressable key={`${reference.itemId ?? ""}:${reference.targetId}:${referenceIndex}`} onPress={() => void openAgentReference(reference)} style={[styles.aiReferenceButton, { borderColor: theme.rule }]}><Text numberOfLines={1} style={[styles.aiReferenceText, { color: theme.red, fontFamily: theme.sans }]}>{`[${referenceIndex + 1}] ${reference.title || "原文位置"}`}</Text></Pressable>)}</View> : null}</View>)}
              {aiLoading ? <View style={[styles.aiMessage, styles.aiAssistant, { borderColor: theme.red }]}>{!IS_EINK_RELEASE && !aiStream ? <ActivityIndicator size="small" color={theme.red} /> : null}<Text style={[styles.aiMessageText, { color: theme.ink, fontFamily: theme.serif }]}>{aiStream || "正在查找原文"}</Text></View> : null}
              {aiError ? <PanelError message={aiError} theme={theme} /> : null}
            </ScrollView>
            <View style={[styles.aiComposer, { borderTopColor: theme.rule }]}><TextInput value={aiInput} onChangeText={setAiInput} placeholder="问这本书……" placeholderTextColor={theme.muted} multiline style={[styles.aiInput, { color: theme.ink, borderBottomColor: theme.ruleDark, fontFamily: theme.serif }]} /><Pressable disabled={!aiInput.trim() || aiLoading} onPress={() => askAi(aiInput)} style={styles.aiSubmit}><Text style={[styles.searchSubmit, { color: theme.red, opacity: !aiInput.trim() || aiLoading ? 0.35 : 1, fontFamily: theme.sans }]}>提问 →</Text></Pressable></View>
          </>
        </ReaderNavigationSheet> : null}

        {activeTool === "progress" ? <ReaderNavigationSheet onClose={() => setActiveTool(null)} top={insets.top + 64} bottom={sheetBottom} theme={theme} compact>
          <ScrollView contentContainerStyle={styles.progressContent}>
            <View style={styles.progressStats}>
              <View style={styles.progressStat}><Text style={[styles.progressValue, { color: theme.ink, fontFamily: theme.sans }]}>{Math.round(previewProgress)}<Text style={styles.progressUnit}>%</Text></Text><Text style={[styles.progressCaption, { color: theme.muted }]}>{previewProgress >= 100 ? "已读完" : remainingMinutes > 0 ? `约${formatReadingTime(remainingMinutes * 60)}后读完` : "暂无预计时长"}</Text></View>
              <View style={[styles.progressStat, { borderLeftWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth, borderColor: theme.rule }]}><Text style={[styles.progressTimeValue, { color: theme.ink, fontFamily: theme.sans }]}>{formatReadingTime(readingTime.seconds)}</Text><Text style={[styles.progressCaption, { color: theme.muted }]}>阅读时长</Text></View>
              <Pressable style={styles.progressStat} accessibilityRole="button" accessibilityLabel={`查看${bookNotes.length}条笔记`} onPress={() => setActiveTool("notes")}><Text style={[styles.progressValue, { color: theme.ink, fontFamily: theme.sans }]}>{bookNotes.length}<Text style={styles.progressUnit}>条</Text></Text><Text style={[styles.progressCaption, { color: theme.muted }]}>笔记</Text></Pressable>
            </View>
            <View style={[styles.progressPreview, { backgroundColor: theme.paperSoft }]}><Text numberOfLines={2} style={[styles.stepTitle, { color: theme.ink, fontFamily: theme.serif }]}>{previewChapter?.title ?? bookTitle}</Text><Text style={[styles.stepMeta, { color: theme.muted }]}>{dragProgress === undefined ? "拖动滑块，跳转全书任意位置" : `全书 ${Math.round(previewProgress)}% · 松手跳转`}</Text></View>
            <View style={styles.bookProgressSlider}><Pressable accessibilityRole="button" accessibilityLabel="上一章" disabled={activeIndex <= 0} onPress={() => chooseProgressChapter(chapters[activeIndex - 1]!.id, "end")} style={[styles.stepButton, { opacity: activeIndex <= 0 ? .28 : 1 }]}><Ionicons name="chevron-back" size={20} color={theme.ink} /></Pressable><ReaderSlider label="全书阅读进度" minimumValue={0} maximumValue={100} value={progress} onSlidingStart={setDragProgress} onValueChange={setDragProgress} onSlidingComplete={goToBookProgress} color={theme.red} trackColor={theme.rule} style={styles.bookSlider} /><Pressable accessibilityRole="button" accessibilityLabel="下一章" disabled={activeIndex >= chapters.length - 1} onPress={() => chooseProgressChapter(chapters[activeIndex + 1]!.id)} style={[styles.stepButton, { opacity: activeIndex >= chapters.length - 1 ? .28 : 1 }]}><Ionicons name="chevron-forward" size={20} color={theme.ink} /></Pressable></View>
          </ScrollView>
        </ReaderNavigationSheet> : null}

        {activeTool === "notes" ? <ReaderNavigationSheet onClose={() => setActiveTool(null)} top={insets.top + 64} bottom={sheetBottom} theme={theme}>
          <SheetHeader title="划线与笔记" meta={`${bookNotes.length}条`} theme={theme} />
          {legacyNoteCount > 0 && user ? <View style={{ padding: 20, gap: 8 }}><Text style={{ color: theme.muted }}>本机有 {legacyNoteCount} 条本地笔记，尚未归属账号。</Text><Pressable accessibilityRole="button" onPress={() => claimLegacyBookAnnotations(datasetId, itemKey, user.id)}><Text style={{ color: theme.red }}>归入当前账号（保持本地保存）</Text></Pressable></View> : null}
          {cloudAnnotations.loading ? <PanelStatus label="正在读取笔记" theme={theme} loading /> : null}
          {cloudAnnotations.error ? <><PanelError message={cloudAnnotations.error} theme={theme} /><Pressable accessibilityRole="button" onPress={cloudAnnotations.refresh}><Text style={[styles.noteAction, { color: theme.red, padding: 16 }]}>重试读取笔记</Text></Pressable></> : null}
          {!cloudAnnotations.loading && !cloudAnnotations.error && bookNotes.length === 0 ? <PanelStatus label="还没有划线或笔记" theme={theme} /> : null}
          <FlatList data={bookNotes} keyExtractor={(item) => item.id} renderItem={({ item }) => <View style={[styles.noteRow, { borderBottomColor: theme.rule }]}>
            <Pressable accessibilityRole="button" accessibilityLabel={`定位笔记：${item.quote}`} onPress={() => locateText(item.chapterId, item.quote)}><Text style={[styles.noteChapter, { color: theme.red, fontFamily: theme.sans }]}>{item.chapterTitle}</Text><Text numberOfLines={3} style={[styles.noteQuote, { color: theme.ink, fontFamily: theme.serif }]}>{item.quote}</Text></Pressable>
            {item.thread ? <>
              {item.thread.comments.filter((comment) => comment.authorId === user?.id).map((comment) => <View key={comment.id}><Text style={[styles.noteBody, { color: theme.ink, fontFamily: theme.serif }]}>{comment.body}</Text><Text style={[styles.noteAction, { color: theme.muted }]}>{comment.visibility === "private" ? "仅自己可见" : "公开"}</Text></View>)}
              <View style={styles.noteActions}><Pressable accessibilityRole="button" onPress={() => openDiscussion(item.thread!)} hitSlop={8}><Text style={[styles.noteAction, { color: theme.red, fontFamily: theme.sans }]}>查看想法</Text></Pressable></View>
            </> : <>
              {item.note ? <Text style={[styles.noteBody, { color: theme.muted, fontFamily: theme.serif }]}>{item.note}</Text> : null}
              <View style={styles.noteActions}><Pressable accessibilityRole="button" onPress={() => { setNoteComposer({ annotationId: item.id, quote: item.quote }); setNoteDraft(item.note ?? ""); setNoteVisibility("private"); setNoteError(""); }} hitSlop={8}><Text style={[styles.noteAction, { color: theme.red, fontFamily: theme.sans }]}>编辑</Text></Pressable><Pressable accessibilityRole="button" onPress={() => deleteAnnotation(item)} hitSlop={8}><Text style={[styles.noteAction, { color: theme.muted, fontFamily: theme.sans }]}>删除</Text></Pressable></View>
            </>}
          </View>} />
        </ReaderNavigationSheet> : null}

        {activeTool === "text" ? <ReaderNavigationSheet onClose={() => setActiveTool(null)} top={insets.top + 64} bottom={sheetBottom} theme={theme}><ScrollView contentContainerStyle={styles.displayContent}>
          <SettingGroup label="亮度" theme={theme}><Ionicons name="sunny-outline" size={17} color={theme.muted} /><ReaderSlider label="屏幕亮度" minimumValue={0.05} maximumValue={1} value={brightness} onValueChange={setBrightness} onSlidingComplete={(value) => { void Brightness.setBrightnessAsync(value); setActiveTool(null); }} color={theme.red} trackColor={theme.rule} style={styles.brightnessSlider} /><Ionicons name="sunny" size={19} color={theme.ink} /></SettingGroup>
          {!IS_EINK_RELEASE ? <SettingGroup label="颜色" theme={theme}>{(["ivory", "white", "dark"] as const).map((value) => <ColorOption key={value} value={value} selected={bookPaperColor === value} onPress={() => choosePaperColor(value)} theme={theme} />)}</SettingGroup> : null}
          <SettingGroup label="字号" theme={theme}>{([{ value: 0.9 as const, label: "小" }, { value: 1 as const, label: "标准" }, { value: 1.12 as const, label: "大" }]).map((option) => <ReaderOption key={option.value} label={option.label} selected={option.value === textScale} onPress={() => chooseTextScale(option.value)} theme={theme} />)}</SettingGroup>
          <SettingGroup label="行距" theme={theme}>{([1.75, 1.95, 2.15] as const).map((value, index) => <ReaderOption key={value} label={["紧凑", "标准", "宽松"][index]!} selected={value === bookLineHeight} onPress={() => chooseLineHeight(value)} theme={theme} />)}</SettingGroup>
          <SettingGroup label="首行" theme={theme}><ReaderOption label="不缩进" selected={!bookFirstLineIndent} onPress={() => chooseFirstLineIndent(false)} theme={theme} /><ReaderOption label="缩进两格" selected={bookFirstLineIndent} onPress={() => chooseFirstLineIndent(true)} theme={theme} /></SettingGroup>
          <SettingGroup label="阅读方式" theme={theme}><ReaderOption label="翻页" selected={bookReadingMode === "paged"} onPress={() => chooseReadingMode("paged")} theme={theme} /><ReaderOption label="滚动" selected={bookReadingMode === "scroll"} onPress={() => chooseReadingMode("scroll")} theme={theme} /></SettingGroup>
        </ScrollView></ReaderNavigationSheet> : null}

        <View style={[styles.toolbar, { bottom: insets.bottom, borderTopColor: theme.ruleDark, backgroundColor: theme.paper }]}>{([
          { id: "toc" as const, label: "目录", icon: "list-outline" as const },
          { id: "ai" as const, label: "AI", icon: "sparkles-outline" as const },
          { id: "progress" as const, label: "进度", icon: "radio-button-on-outline" as const },
          { id: "notes" as const, label: "笔记", icon: "create-outline" as const },
          { id: "text" as const, label: "文字", icon: "text-outline" as const },
        ]).map((tool) => { const selected = activeTool === tool.id; return <Pressable key={tool.id} accessibilityRole="button" accessibilityState={{ selected, expanded: selected }} onPress={() => toggleTool(tool.id)} style={styles.toolButton}><Ionicons name={tool.icon} size={20} color={selected ? theme.red : theme.ink} /><Text style={[styles.toolText, { color: selected ? theme.red : theme.ink, fontFamily: theme.sans }]}>{tool.label}</Text></Pressable>; })}</View>
      </> : null}

      {selection ? <ReaderSelectionToolbar selection={selection} frame={readerFrame} theme={theme} eInk={IS_EINK_RELEASE} onCopy={() => { void Clipboard.setStringAsync(selection.text); clearSelection(); }} onUnderline={underlineSelection} onThought={composeSelectionNote} onExplain={explainSelection} /> : null}
      <BookThoughtComposer quote={noteComposer?.quote} value={noteDraft} visibility={noteVisibility} onVisibilityChange={setNoteVisibility} saving={noteSaving} error={noteError} localOnly={!user} onChange={setNoteDraft} onCancel={() => { if (!noteSaving) { setNoteComposer(undefined); setNoteDraft(""); setActiveAnnotationId(undefined); } }} onSave={() => void saveNote()} onSaveLocal={user ? saveNoteLocally : undefined} theme={theme} />
      {activeCloudThread && user ? <AnnotationDiscussionPanel key={`${user.id}:${activeCloudThread.id}`} thread={activeCloudThread} currentUserId={user.id} theme={theme}
        onClose={() => setActiveAnnotationId(undefined)}
        onComment={(body, parentId, visibility) => cloudAnnotations.comment(activeCloudThread, body, parentId, visibility)}
        onReport={(commentId, reason, details) => cloudAnnotations.report(activeCloudThread, commentId, reason, details)} /> : null}
      {loaded && activeChapterId ? <NativeSpeechPlayer documentId={`book:${datasetId}:${itemKey}`} title={loaded.manifest.title} chapterId={activeChapterId} chapters={loaded.manifest.content.chapters ?? []} loadChapter={loadSpeechChapter} getReadingPosition={getSpeechPosition} onSpeechLocation={showSpeechLocation} cover={speechCover ? { uri: speechCover } : undefined} hidden={!chromeVisible || Boolean(activeTool || selection || noteComposer || activeAnnotationId || expandedImageUri)} bottom={insets.bottom + 64} onRead={(id, location) => location ? showSpeechLocation(location, true) : chooseChapter(id)} onBookshelf={() => void toggleBookshelf()} onShelf={onBookshelf} bookshelfBusy={bookshelfBusy} /> : null}
      {readerNotice ? <Pressable onPress={() => setReaderNotice("")} style={[styles.readerNotice, { top: insets.top + 72, borderColor: theme.red, backgroundColor: theme.paper }]}><Text style={[styles.readerNoticeText, { color: theme.red, fontFamily: theme.sans }]}>{readerNotice}</Text></Pressable> : null}
      <Modal visible={Boolean(expandedImageUri)} transparent={false} animationType={IS_EINK_RELEASE ? "none" : "fade"} onRequestClose={() => setExpandedImageUri(undefined)}>
        <SafeAreaView edges={["top", "bottom"]} style={[styles.imageModal, { backgroundColor: theme.paper }]}>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭图片预览" accessibilityHint="点击图片或空白处返回阅读" onPress={() => setExpandedImageUri(undefined)} style={styles.imageModal}>
            <View pointerEvents="none" style={styles.imageModal}>
              {expandedImageUri ? <Image accessible={false} source={{ uri: expandedImageUri }} resizeMode="contain" style={styles.expandedImage} /> : null}
            </View>
          </Pressable>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function SheetHeader({ title, meta, theme, accentMeta = false }: { title: string; meta: string; theme: MobileTheme; accentMeta?: boolean }) {
  return <View style={[styles.sheetHeader, { borderBottomColor: theme.rule }]}><Text style={[styles.sheetTitle, { color: theme.ink, fontFamily: theme.serif }]}>{title}</Text><Text numberOfLines={1} style={[styles.sheetMeta, { color: accentMeta ? theme.red : theme.muted, fontFamily: theme.sans }]}>{meta}</Text></View>;
}
function AiPanelHeader({ title, disabled, onNewConversation, theme }: {
  title: string;
  disabled: boolean;
  onNewConversation: () => void;
  theme: MobileTheme;
}) {
  return <View style={[styles.aiPanelHeader, { borderBottomColor: theme.rule }]}><View style={styles.aiPanelHeading}><Text style={[styles.aiPanelTitle, { color: theme.ink, fontFamily: theme.serif }]}>书内 AI</Text><Text numberOfLines={1} style={[styles.aiPanelBook, { color: theme.muted, fontFamily: theme.sans }]}>{title}</Text></View><Pressable accessibilityRole="button" disabled={disabled} onPress={onNewConversation} hitSlop={8}><Text style={[styles.aiNewConversation, { color: theme.red, opacity: disabled ? 0.35 : 1, fontFamily: theme.sans }]}>＋ 新对话</Text></Pressable></View>;
}
function SettingGroup({ label, children, theme }: { label: string; children: ReactNode; theme: MobileTheme }) {
  return <View style={styles.settingGroup}><Text style={[styles.settingsLabel, { color: theme.muted, fontFamily: theme.sans }]}>{label}</Text><View style={styles.scaleRow}>{children}</View></View>;
}
function ReaderOption({ label, selected, onPress, theme }: { label: string; selected: boolean; onPress: () => void; theme: MobileTheme }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={[styles.scaleButton, { borderColor: selected ? theme.red : "transparent", backgroundColor: theme.paper }]}><Text style={[styles.scaleButtonText, { color: selected ? theme.red : theme.ink, fontFamily: theme.sans }]}>{label}</Text></Pressable>;
}
function ColorOption({ value, selected, onPress, theme }: { value: BookPaperColor; selected: boolean; onPress: () => void; theme: MobileTheme }) {
  const colors = value === "ivory" ? { paper: "#fbfaf6", ink: "#202020", label: "米白" } : value === "white" ? { paper: "#ffffff", ink: "#202020", label: "白色" } : { paper: "#202321", ink: "#deded8", label: "夜间" };
  return <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={[styles.scaleButton, { borderColor: selected ? theme.red : "transparent", backgroundColor: colors.paper }]}><Text style={[styles.scaleButtonText, { color: colors.ink, fontFamily: theme.sans }]}>{colors.label}</Text></Pressable>;
}
function PanelStatus({ label, theme, loading = false }: { label: string; theme: MobileTheme; loading?: boolean }) {
  return <View style={styles.panelStatus}>{loading && !IS_EINK_RELEASE ? <ActivityIndicator size="small" color={theme.red} /> : null}<Text style={[styles.panelStatusText, { color: theme.muted, fontFamily: theme.sans }]}>{label}</Text></View>;
}
function PanelError({ message, theme }: { message: string; theme: MobileTheme }) {
  return <Text accessibilityRole="alert" style={[styles.panelError, { color: theme.red, borderLeftColor: theme.red, fontFamily: theme.sans }]}>{message}</Text>;
}

const styles = StyleSheet.create({
  safe: { flex: 1 }, reader: { flex: 1 },
  header: { position: "absolute", zIndex: 4, left: 0, right: 0, minHeight: 64, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center", paddingHorizontal: 8 },
  iconButton: { width: 44, height: 48, alignItems: "center", justifyContent: "center" }, referenceBack: { width: 66, flexDirection: "row" }, referenceBackText: { marginLeft: -3, fontSize: 9, fontWeight: "800" }, headerCopy: { flex: 1, minWidth: 0 }, bookTitle: { fontSize: 16, fontWeight: "900" }, chapterTitle: { marginTop: 3, fontSize: 9 }, progress: { marginHorizontal: 10, fontSize: 10, fontWeight: "900" },
  center: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", padding: 28 }, status: { marginTop: 10, fontSize: 11, fontWeight: "700" }, error: { fontSize: 18, fontWeight: "900", textAlign: "center" }, retry: { marginTop: 18, borderWidth: 1, paddingHorizontal: 20, paddingVertical: 10 }, retryText: { fontSize: 11, fontWeight: "900" },
  toolbar: { position: "absolute", zIndex: 4, left: 0, right: 0, minHeight: 64, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "stretch", paddingHorizontal: 3 }, toolButton: { flex: 1, minHeight: 58, alignItems: "center", justifyContent: "center", gap: 3 }, toolText: { fontSize: 9, fontWeight: "800" },
  toolSheet: { position: "absolute", zIndex: 3, left: 0, right: 0, borderTopWidth: 1 }, fullSheet: { minHeight: 220 }, compactSheet: { minHeight: 218, paddingHorizontal: 18 }, displaySheet: { minHeight: 300 }, displayContent: { paddingHorizontal: 18, paddingVertical: 10 },
  sheetHeader: { minHeight: 52, marginHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center", gap: 20 }, sheetTitle: { flex: 1, fontSize: 16, fontWeight: "900" }, sheetMeta: { maxWidth: "60%", fontSize: 10, fontWeight: "800" },
  searchHeader: { paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth }, searchBox: { marginTop: 12, height: 42, borderBottomWidth: 1, flexDirection: "row", alignItems: "center", gap: 10 }, searchInput: { flex: 1, height: 42, paddingVertical: 0, fontSize: 14 }, searchSubmit: { fontSize: 11, fontWeight: "900" }, tocSearch: { marginHorizontal: 18, height: 42, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center", gap: 9 }, tocSearchInput: { flex: 1, height: 42, paddingVertical: 0, fontSize: 12 }, resultRow: { borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 20, paddingVertical: 15 }, resultTitle: { fontSize: 13, fontWeight: "900" }, resultExcerpt: { marginTop: 7, fontSize: 12, lineHeight: 22 }, panelStatus: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 20, paddingVertical: 18 }, panelStatusText: { fontSize: 11, fontWeight: "700" }, panelError: { margin: 18, borderLeftWidth: 2, paddingLeft: 10, fontSize: 11, lineHeight: 20 },
  aiPanelHeader: { minHeight: 62, marginHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center", gap: 14 }, aiPanelHeading: { flex: 1, minWidth: 0 }, aiPanelTitle: { fontSize: 16, fontWeight: "900" }, aiPanelBook: { marginTop: 3, fontSize: 8, fontWeight: "700" }, aiNewConversation: { fontSize: 10, fontWeight: "900" },
  aiHistory: { flex: 1 }, aiHistoryContent: { padding: 18, gap: 16 }, aiEmpty: { borderLeftWidth: 2, paddingLeft: 12, paddingVertical: 3 }, aiEmptyTitle: { fontSize: 14, fontWeight: "900" }, aiEmptyText: { marginTop: 6, fontSize: 10, lineHeight: 18 }, aiMessage: { maxWidth: "88%", borderLeftWidth: 2, paddingLeft: 12 }, aiUser: { alignSelf: "flex-end", borderLeftWidth: 0, borderRightWidth: 2, paddingLeft: 0, paddingRight: 12 }, aiAssistant: { alignSelf: "flex-start" }, aiMessageText: { fontSize: 13, lineHeight: 23 }, aiReferences: { marginTop: 10, gap: 6 }, aiReferenceButton: { borderWidth: 1, paddingHorizontal: 9, paddingVertical: 7 }, aiReferenceText: { fontSize: 10, fontWeight: "800" }, aiComposer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 18, paddingVertical: 12, flexDirection: "row", alignItems: "flex-end", gap: 14 }, aiInput: { flex: 1, minHeight: 42, maxHeight: 92, borderBottomWidth: 1, paddingVertical: 8, fontSize: 13 }, aiSubmit: { minHeight: 42, justifyContent: "center" },
  progressContent: { paddingHorizontal: 20, paddingBottom: 20 }, progressStats: { flexDirection: "row", paddingVertical: 24 }, progressStat: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 4, gap: 9 }, progressValue: { fontSize: 30, fontWeight: "700" }, progressUnit: { fontSize: 12 }, progressTimeValue: { fontSize: 18, fontWeight: "700", textAlign: "center" }, progressCaption: { fontSize: 10, textAlign: "center", lineHeight: 16 }, progressPreview: { minHeight: 72, padding: 14, alignItems: "center", justifyContent: "center" }, bookProgressSlider: { flexDirection: "row", alignItems: "center", marginTop: 12 }, bookSlider: { flex: 1, height: 44 },
  chapterStepper: { minHeight: 80, flexDirection: "row", alignItems: "center" }, stepButton: { width: 52, height: 52, alignItems: "center", justifyContent: "center" }, stepCopy: { flex: 1, alignItems: "center", paddingHorizontal: 10 }, stepTitle: { fontSize: 15, fontWeight: "900" }, stepMeta: { marginTop: 5, fontSize: 9, fontWeight: "700" }, pageProgress: { paddingTop: 16 }, progressRail: { height: 4, marginHorizontal: 10, justifyContent: "center" }, progressFill: { position: "absolute", left: 0, height: 4 }, progressThumb: { position: "absolute", width: 18, height: 18, marginLeft: -9 }, pageLabel: { marginTop: 15, textAlign: "center", fontSize: 10, fontWeight: "700" },
  settingGroup: { minHeight: 59, flexDirection: "row", alignItems: "center" }, settingsLabel: { width: 72, fontSize: 10, fontWeight: "800" }, scaleRow: { flex: 1, flexDirection: "row", alignItems: "center", gap: 7 }, scaleButton: { flex: 1, height: 38, borderWidth: 1, alignItems: "center", justifyContent: "center" }, scaleButtonText: { fontSize: 10, fontWeight: "900" }, brightnessSlider: { flex: 1, height: 40 },
  chapterRow: { height: 68, marginHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center", paddingHorizontal: 12 }, chapterNumber: { width: 38, fontSize: 9, fontWeight: "700" }, chapterCopy: { flex: 1 }, chapterRowTitle: { fontSize: 14, fontWeight: "700", lineHeight: 21 }, currentChapter: { fontSize: 9, fontWeight: "700" }, currentChapterMark: { marginLeft: 12, flexDirection: "row", gap: 4, alignItems: "center" },
  noteComposer: { position: "absolute", zIndex: 8, left: 16, right: 16, borderWidth: 1, padding: 14 }, composerQuote: { borderLeftWidth: 2, paddingLeft: 9, fontSize: 11, lineHeight: 19 }, noteInput: { minHeight: 64, marginTop: 9, borderBottomWidth: 1, paddingVertical: 8, textAlignVertical: "top", fontSize: 13 }, composerActions: { marginTop: 11, flexDirection: "row", justifyContent: "flex-end", gap: 24 }, composerButton: { fontSize: 11, fontWeight: "900" },
  noteRow: { marginHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 14 }, noteChapter: { fontSize: 9, fontWeight: "900" }, noteQuote: { marginTop: 6, fontSize: 13, lineHeight: 21 }, noteBody: { marginTop: 8, fontSize: 11, lineHeight: 19 }, noteActions: { marginTop: 10, flexDirection: "row", justifyContent: "flex-end", gap: 22 }, noteAction: { fontSize: 10, fontWeight: "900" },
  readerNotice: { position: "absolute", zIndex: 9, left: 18, right: 18, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 11 }, readerNoticeText: { fontSize: 11, fontWeight: "800", textAlign: "center" }, imageModal: { flex: 1 }, expandedImage: { flex: 1, width: "100%", height: "100%" },
});
