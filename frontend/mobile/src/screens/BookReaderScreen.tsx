import Ionicons from "@expo/vector-icons/Ionicons";
import Slider from "@react-native-community/slider";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Brightness from "expo-brightness";
import * as Clipboard from "expo-clipboard";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, FlatList, Image, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { ReaderEnvironment } from "../components/ReaderEnvironment";
import { IS_EINK_RELEASE } from "../config/appVariant";
import {
  askMobileBookAgent,
  type MobileBookAgentReference,
} from "../lib/bookAgent";
import { createBookDocument } from "../lib/bookDocument";
import {
  createBookReaderApplyAnnotationScript,
  createBookReaderBridgeScript,
  createBookReaderClearSelectionScript,
  createBookReaderGoToSpreadScript,
  createBookReaderLocateTextScript,
  createBookReaderRemoveAnnotationScript,
  createBookReaderRevealAnchorScript,
  parseBookReaderMessage,
  type BookChapterEdge,
  type BookReaderPageMessage,
  type BookReaderSelectionMessage,
  type BookReadingMode,
} from "../lib/bookReaderBridge";
import {
  loadMobileBookChapter,
  loadMobileBookItem,
  loadMobileBookVolumes,
  resolveMobileAnnotationReference,
  searchMobileBook,
  type LoadedMobileBookChapter,
  type LoadedMobileBookItem,
  type MobileBookSearchResult,
} from "../lib/books";
import { selectionHaptic } from "../lib/haptics";
import type { RootStackParamList } from "../navigation/types";
import { useMobileStore, type BookAnnotation, type BookPaperColor } from "../store/mobileStore";
import { mobileTheme, type MobileTheme } from "../theme/tokens";

type Props = NativeStackScreenProps<RootStackParamList, "BookReader">;
type ReaderTool = "toc" | "search" | "ai" | "progress" | "notes" | "text";
type AiMessage = { role: "user" | "assistant"; content: string; references?: MobileBookAgentReference[] };
type NoteComposer = { annotationId?: string; selection?: BookReaderSelectionMessage; quote: string };
type PendingLocate = { chapterId: string; text?: string; anchorId?: string; spreadIndex?: number };

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

  const textScale = useMobileStore((state) => state.textScale);
  const setTextScale = useMobileStore((state) => state.setTextScale);
  const bookLineHeight = useMobileStore((state) => state.bookLineHeight);
  const setBookLineHeight = useMobileStore((state) => state.setBookLineHeight);
  const bookReadingMode = useMobileStore((state) => state.bookReadingMode);
  const setBookReadingMode = useMobileStore((state) => state.setBookReadingMode);
  const bookPaperColor = useMobileStore((state) => state.bookPaperColor);
  const setBookPaperColor = useMobileStore((state) => state.setBookPaperColor);
  const bookFirstLineIndent = useMobileStore((state) => state.bookFirstLineIndent);
  const setBookFirstLineIndent = useMobileStore((state) => state.setBookFirstLineIndent);
  const hapticsEnabled = useMobileStore((state) => state.hapticsEnabled);
  const leftTapNext = useMobileStore((state) => state.leftTapNext);
  const rememberBook = useMobileStore((state) => state.rememberBook);
  const annotations = useMobileStore((state) => state.bookAnnotations);
  const addBookAnnotation = useMobileStore((state) => state.addBookAnnotation);
  const updateBookAnnotationNote = useMobileStore((state) => state.updateBookAnnotationNote);
  const removeBookAnnotation = useMobileStore((state) => state.removeBookAnnotation);

  const theme = useMemo(() => readerTheme(bookPaperColor), [bookPaperColor]);
  const [loaded, setLoaded] = useState<LoadedMobileBookItem>();
  const [chapter, setChapter] = useState<LoadedMobileBookChapter>();
  const [activeChapterId, setActiveChapterId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [chromeVisible, setChromeVisible] = useState(true);
  const [activeTool, setActiveTool] = useState<ReaderTool | null>(null);
  const [pageState, setPageState] = useState<BookReaderPageMessage>();
  const [chapterEntryEdge, setChapterEntryEdge] = useState<BookChapterEdge>("start");
  const [retryToken, setRetryToken] = useState(0);
  const [progressRailWidth, setProgressRailWidth] = useState(1);
  const [selection, setSelection] = useState<BookReaderSelectionMessage>();
  const [noteComposer, setNoteComposer] = useState<NoteComposer>();
  const [noteDraft, setNoteDraft] = useState("");
  const [activeAnnotationId, setActiveAnnotationId] = useState<string>();
  const [brightness, setBrightness] = useState(0.65);
  const [searchQuery, setSearchQuery] = useState("");
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
  const [referenceHistory, setReferenceHistory] = useState<Array<{ chapterId: string; spreadIndex: number }>>([]);
  const [tocQuery, setTocQuery] = useState("");
  const [expandedImageUri, setExpandedImageUri] = useState<string>();
  const [readerNotice, setReaderNotice] = useState("");

  useEffect(() => {
    let active = true;
    void Brightness.getBrightnessAsync().then((value) => { if (active) setBrightness(value); }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => () => cancelAgentRef.current?.(), []);

  useEffect(() => {
    let active = true;
    const routeBook = `${datasetId}\0${itemKey}`;
    const bookChanged = aiBookRouteRef.current !== routeBook;
    aiBookRouteRef.current = routeBook;
    if (bookChanged) {
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
    setLoading(true);
    setError("");
    void loadMobileBookItem(datasetId, itemKey)
      .then((value) => {
        if (!active) return;
        const firstChapter = value.manifest.content.chapters?.find((candidate) => candidate.id === initialChapterId)
          ?? value.manifest.content.chapters?.[0];
        if (!firstChapter) throw new Error("书籍没有可读章节");
        setLoaded(value);
        if (initialAnchorId || initialText) {
          pendingLocateRef.current = { chapterId: firstChapter.id, anchorId: initialAnchorId, text: initialText };
        }
        setActiveChapterId(firstChapter.id);
      })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "无法打开书籍"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [datasetId, initialAnchorId, initialChapterId, initialText, itemKey, retryToken]);

  useEffect(() => {
    if (!loaded || !activeChapterId) return;
    let active = true;
    setLoading(true);
    setError("");
    setChapter(undefined);
    setSelection(undefined);
    void loadMobileBookChapter(loaded, activeChapterId)
      .then((value) => { if (active) setChapter(value); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "无法读取章节"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [activeChapterId, loaded, retryToken]);

  const chapters = loaded?.manifest.content.chapters ?? [];
  const activeIndex = Math.max(0, chapters.findIndex((candidate) => candidate.id === activeChapterId));
  const bookAnnotations = useMemo(() => annotations.filter((annotation) => (
    annotation.datasetId === datasetId && annotation.itemKey === itemKey
  )), [annotations, datasetId, itemKey]);
  const chapterAnnotations = useMemo(() => bookAnnotations.filter((annotation) => annotation.chapterId === activeChapterId), [activeChapterId, bookAnnotations]);
  const visibleChapters = useMemo(() => {
    const query = tocQuery.normalize("NFKC").trim().toLocaleLowerCase();
    return query ? chapters.filter((candidate) => candidate.title.normalize("NFKC").toLocaleLowerCase().includes(query)) : chapters;
  }, [chapters, tocQuery]);
  const chapterPageProgress = pageState?.paged && pageState.pageCount > 0 ? pageState.pageEnd / pageState.pageCount : 0;
  const progress = chapters.length ? Math.min(100, Math.round(((activeIndex + chapterPageProgress) / chapters.length) * 100)) : 0;
  const readerStatus = bookReadingMode === "paged" && pageState?.paged
    ? `${pageState.pageStart}${pageState.pageEnd > pageState.pageStart ? `–${pageState.pageEnd}` : ""} / ${pageState.pageCount}`
    : `全书 ${progress}%`;
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
    chapterAnnotations.map(({ id, start, end }) => ({ id, start, end })),
  ), [activeChapterId, chapterAnnotations, chapterEntryEdge, leftTapNext]);

  useEffect(() => {
    if (chapter) rememberBook({ datasetId, itemKey, title, subtitle: bookTitle, progress });
  }, [bookTitle, chapter, datasetId, itemKey, progress, rememberBook, title]);

  useEffect(() => {
    if (!chapter || activeTool || selection || noteComposer || !chromeVisible) return;
    const timer = setTimeout(() => setChromeVisible(false), 3200);
    return () => clearTimeout(timer);
  }, [activeChapterId, activeTool, chapter, chromeVisible, noteComposer, selection]);

  function chooseChapter(chapterId: string, entryEdge: BookChapterEdge = "start") {
    setActiveTool(null);
    setChromeVisible(true);
    setPageState(undefined);
    setChapterEntryEdge(entryEdge);
    setActiveChapterId(chapterId);
  }

  function clearSelection() {
    setSelection(undefined);
    webViewRef.current?.injectJavaScript(createBookReaderClearSelectionScript());
  }

  function handleReaderMessage(event: WebViewMessageEvent) {
    const message = parseBookReaderMessage(event.nativeEvent.data);
    if (!message) return;
    if (message.type === "reader-selection") {
      setSelection(message);
      setActiveTool(null);
      setChromeVisible(true);
      void selectionHaptic(hapticsEnabled);
      return;
    }
    if (message.type === "reader-annotation") {
      const annotation = bookAnnotations.find((candidate) => candidate.id === message.id);
      if (annotation) {
        setActiveAnnotationId(annotation.id);
        setNoteComposer({ annotationId: annotation.id, quote: annotation.quote });
        setNoteDraft(annotation.note ?? "");
        setActiveTool("notes");
        setChromeVisible(true);
      }
      return;
    }
    if (message.type === "reader-internal-link") {
      if (!chapters.some((candidate) => candidate.id === message.chapterId)) return;
      setReferenceHistory((history) => [...history, { chapterId: activeChapterId, spreadIndex: pageState?.spreadIndex ?? 0 }]);
      pendingLocateRef.current = { chapterId: message.chapterId, anchorId: message.anchorId };
      chooseChapter(message.chapterId);
      return;
    }
    if (message.type === "reader-image") {
      const uri = chapter?.assetUrls[message.assetId];
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
      setPageState(message);
      if (chapterEntryEdge === "end") setChapterEntryEdge("start");
      return;
    }
    if (message.direction === "previous" && activeIndex > 0) chooseChapter(chapters[activeIndex - 1]!.id, "end");
    else if (message.direction === "next" && activeIndex < chapters.length - 1) chooseChapter(chapters[activeIndex + 1]!.id);
  }

  function resetPage() {
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
    setActiveTool((current) => current === tool ? null : tool);
    void selectionHaptic(hapticsEnabled);
  }
  function goToSpread(spreadIndex: number) {
    if (!pageState?.paged) return;
    webViewRef.current?.injectJavaScript(createBookReaderGoToSpreadScript(spreadIndex));
    void selectionHaptic(hapticsEnabled);
  }
  function locateText(chapterId: string, text: string) {
    const target = text.trim();
    if (!target) return;
    setActiveTool(null);
    setChromeVisible(false);
    if (chapterId === activeChapterId && chapter) {
      webViewRef.current?.injectJavaScript(createBookReaderLocateTextScript(target));
      return;
    }
    pendingLocateRef.current = { chapterId, text: target };
    chooseChapter(chapterId);
  }
  function handleReaderLoaded() {
    const pending = pendingLocateRef.current;
    if (!pending || pending.chapterId !== activeChapterId) return;
    pendingLocateRef.current = undefined;
    setTimeout(() => {
      if (pending.text) webViewRef.current?.injectJavaScript(createBookReaderLocateTextScript(pending.text));
      else if (pending.anchorId) webViewRef.current?.injectJavaScript(createBookReaderRevealAnchorScript(pending.anchorId));
      else if (typeof pending.spreadIndex === "number") webViewRef.current?.injectJavaScript(createBookReaderGoToSpreadScript(pending.spreadIndex));
    }, 80);
  }
  function handleBack() {
    const previous = referenceHistory[referenceHistory.length - 1];
    if (!previous) {
      navigation.goBack();
      return;
    }
    setReferenceHistory((history) => history.slice(0, -1));
    pendingLocateRef.current = { chapterId: previous.chapterId, spreadIndex: previous.spreadIndex };
    chooseChapter(previous.chapterId);
  }
  async function openAgentReference(reference: MobileBookAgentReference) {
    if (!loaded || !reference.targetId) return;
    setReaderNotice("");
    if (!reference.itemId || reference.itemId === loaded.volume.itemId) {
      if (reference.anchorId) {
        if (reference.targetId === activeChapterId && chapter) {
          webViewRef.current?.injectJavaScript(createBookReaderRevealAnchorScript(reference.anchorId));
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
      datasetId,
      itemKey,
      chapterId: activeChapterId,
      chapterTitle: chapters[activeIndex]?.title ?? chapter?.fragment.title ?? "正文",
      start: selected.start,
      end: selected.end,
      quote: selected.text,
      note: note?.trim() || undefined,
    });
    webViewRef.current?.injectJavaScript(createBookReaderApplyAnnotationScript(created));
    clearSelection();
    return created;
  }
  function underlineSelection() {
    if (!selection) return;
    createAnnotation(selection);
    void selectionHaptic(hapticsEnabled);
  }
  function composeSelectionNote() {
    if (!selection) return;
    setNoteComposer({ selection, quote: selection.text });
    setNoteDraft("");
    clearSelection();
  }
  function saveNote() {
    if (!noteComposer || !noteDraft.trim()) return;
    if (noteComposer.annotationId) updateBookAnnotationNote(noteComposer.annotationId, noteDraft);
    else if (noteComposer.selection) {
      const created = createAnnotation(noteComposer.selection, noteDraft);
      setActiveAnnotationId(created.id);
    }
    setNoteComposer(undefined);
    setNoteDraft("");
    setActiveTool("notes");
    void selectionHaptic(hapticsEnabled);
  }
  function deleteAnnotation(annotation: BookAnnotation) {
    removeBookAnnotation(annotation.id);
    if (annotation.chapterId === activeChapterId) webViewRef.current?.injectJavaScript(createBookReaderRemoveAnnotationScript(annotation.id));
    if (activeAnnotationId === annotation.id) setActiveAnnotationId(undefined);
    if (noteComposer?.annotationId === annotation.id) setNoteComposer(undefined);
    void selectionHaptic(hapticsEnabled);
  }
  async function submitSearch() {
    const query = searchQuery.trim();
    if (!loaded || !query || searching) return;
    setSearching(true);
    setSearchError("");
    try {
      setSearchResults(await searchMobileBook(loaded, query));
      setSearchSearched(true);
    } catch (reason) {
      setSearchError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSearching(false);
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

  const sheetBottom = insets.bottom + 64;
  return (
    <SafeAreaView edges={["top", "bottom"]} style={[styles.safe, { backgroundColor: theme.paper }]}>
      <ReaderEnvironment />
      <View style={[styles.reader, { backgroundColor: theme.paper }]}>
        {chapter ? (
          <WebView
            ref={webViewRef}
            key={`${activeChapterId}:${textScale}:${bookLineHeight}:${bookFirstLineIndent}:${bookReadingMode}:${bookPaperColor}`}
            source={{ html: document }}
            originWhitelist={["about:blank", "data:*"]}
            javaScriptEnabled
            domStorageEnabled={false}
            cacheEnabled={false}
            injectedJavaScript={readerBridgeScript}
            onLoadEnd={handleReaderLoaded}
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
        {!loading && error ? <View style={[styles.center, { backgroundColor: theme.paper }]}><Text accessibilityRole="alert" style={[styles.error, { color: theme.ink, fontFamily: theme.serif }]}>{error}</Text><Pressable onPress={() => setRetryToken((value) => value + 1)} style={[styles.retry, { borderColor: theme.red }]}><Text style={[styles.retryText, { color: theme.red, fontFamily: theme.sans }]}>重新加载</Text></Pressable></View> : null}
      </View>

      {chromeVisible ? <>
        <View style={[styles.header, { top: insets.top, borderBottomColor: theme.ruleDark, backgroundColor: theme.paper }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={referenceHistory.length || returnToReference ? "返回原文" : "返回书籍"} hitSlop={10} onPress={handleBack} style={[styles.iconButton, referenceHistory.length || returnToReference ? styles.referenceBack : null]}><Ionicons name="chevron-back" size={24} color={theme.ink} />{referenceHistory.length || returnToReference ? <Text style={[styles.referenceBackText, { color: theme.ink, fontFamily: theme.sans }]}>原文</Text> : null}</Pressable>
          <View style={styles.headerCopy}><Text numberOfLines={1} style={[styles.bookTitle, { color: theme.ink, fontFamily: theme.serif }]}>{title}</Text><Text numberOfLines={1} style={[styles.chapterTitle, { color: theme.muted, fontFamily: theme.sans }]}>{chapters[activeIndex]?.title ?? bookTitle}</Text></View>
          <Text style={[styles.progress, { color: theme.red, fontFamily: theme.sans }]}>{readerStatus}</Text>
        </View>

        {activeTool === "toc" ? <View style={[styles.toolSheet, styles.fullSheet, { top: insets.top + 64, bottom: sheetBottom, borderColor: theme.ruleDark, backgroundColor: theme.paper }]}>
          <SheetHeader title="目录" meta={tocQuery ? String(visibleChapters.length) : `${activeIndex + 1} / ${chapters.length}`} theme={theme} />
          <View style={[styles.tocSearch, { borderBottomColor: theme.rule }]}><Ionicons name="search-outline" size={16} color={theme.muted} /><TextInput value={tocQuery} onChangeText={setTocQuery} placeholder="搜索目录" placeholderTextColor={theme.muted} style={[styles.tocSearchInput, { color: theme.ink, fontFamily: theme.serif }]} />{tocQuery ? <Pressable onPress={() => setTocQuery("")} hitSlop={8}><Ionicons name="close" size={17} color={theme.muted} /></Pressable> : null}</View>
          <FlatList data={visibleChapters} keyExtractor={(item) => item.id} renderItem={({ item }) => {
            const index = chapters.findIndex((candidate) => candidate.id === item.id);
            const selected = item.id === activeChapterId;
            return <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={() => chooseChapter(item.id)} style={[styles.chapterRow, { borderBottomColor: theme.rule }, selected && { borderLeftColor: theme.red, borderLeftWidth: 3 }]}>
              <Text style={[styles.chapterNumber, { color: selected ? theme.red : theme.muted, fontFamily: theme.sans }]}>{String(index + 1).padStart(2, "0")}</Text>
              <View style={styles.chapterCopy}><Text style={[styles.chapterRowTitle, { color: theme.ink, fontFamily: theme.serif }]}>{item.title}</Text>{selected ? <Text style={[styles.currentChapter, { color: theme.red, fontFamily: theme.sans }]}>当前阅读</Text> : null}</View>
            </Pressable>;
          }} getItemLayout={(_, index) => ({ length: 68, offset: 68 * index, index })} overScrollMode={IS_EINK_RELEASE ? "never" : "always"} />
        </View> : null}

        {activeTool === "search" ? <View style={[styles.toolSheet, styles.fullSheet, { top: insets.top + 64, bottom: sheetBottom, borderColor: theme.ruleDark, backgroundColor: theme.paper }]}>
          <View style={[styles.searchHeader, { borderBottomColor: theme.rule }]}><Text style={[styles.sheetTitle, { color: theme.ink, fontFamily: theme.serif }]}>搜索</Text><View style={[styles.searchBox, { borderBottomColor: theme.ruleDark }]}><Ionicons name="search-outline" size={18} color={theme.muted} /><TextInput autoFocus value={searchQuery} onChangeText={setSearchQuery} onSubmitEditing={() => void submitSearch()} placeholder="搜索正文" placeholderTextColor={theme.muted} returnKeyType="search" style={[styles.searchInput, { color: theme.ink, fontFamily: theme.serif }]} /><Pressable disabled={!searchQuery.trim() || searching} onPress={() => void submitSearch()} hitSlop={8}><Text style={[styles.searchSubmit, { color: theme.red, opacity: !searchQuery.trim() || searching ? 0.35 : 1, fontFamily: theme.sans }]}>搜索</Text></Pressable></View></View>
          {searching ? <PanelStatus label="正在搜索本书" theme={theme} loading /> : null}
          {searchError ? <PanelError message={searchError} theme={theme} /> : null}
          {!searching && searchSearched && searchResults.length === 0 ? <PanelStatus label={`本书没有找到“${searchQuery.trim()}”`} theme={theme} /> : null}
          <FlatList data={searchResults} keyExtractor={(item, index) => `${item.chapterId}:${index}`} keyboardDismissMode="on-drag" renderItem={({ item }) => <Pressable onPress={() => locateText(item.chapterId, item.match)} style={[styles.resultRow, { borderBottomColor: theme.rule }]}><Text style={[styles.resultTitle, { color: theme.red, fontFamily: theme.serif }]}>{item.chapterTitle}</Text><Text style={[styles.resultExcerpt, { color: theme.muted, fontFamily: theme.serif }]}>{item.leadingEllipsis ? "…" : ""}{item.before}<Text style={{ color: theme.ink, fontWeight: "900" }}>{item.match}</Text>{item.after}{item.trailingEllipsis ? "…" : ""}</Text></Pressable>} />
        </View> : null}

        {activeTool === "ai" ? <View style={[styles.toolSheet, styles.fullSheet, { top: insets.top + 64, bottom: sheetBottom, borderColor: theme.ruleDark, backgroundColor: theme.paper }]}>
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
        </View> : null}

        {activeTool === "progress" ? <View style={[styles.toolSheet, styles.compactSheet, { bottom: sheetBottom, borderColor: theme.ruleDark, backgroundColor: theme.paper }]}>
          <SheetHeader title="阅读进度" meta={`${progress}%`} theme={theme} accentMeta />
          <View style={styles.chapterStepper}><Pressable accessibilityRole="button" accessibilityLabel="上一章" disabled={activeIndex <= 0} onPress={() => chooseChapter(chapters[activeIndex - 1]!.id, "end")} style={[styles.stepButton, { opacity: activeIndex <= 0 ? 0.28 : 1 }]}><Ionicons name="chevron-back" size={22} color={theme.ink} /></Pressable><View style={styles.stepCopy}><Text numberOfLines={1} style={[styles.stepTitle, { color: theme.ink, fontFamily: theme.serif }]}>{chapters[activeIndex]?.title ?? bookTitle}</Text><Text style={[styles.stepMeta, { color: theme.muted, fontFamily: theme.sans }]}>第 {activeIndex + 1} / {chapters.length} 章</Text></View><Pressable accessibilityRole="button" accessibilityLabel="下一章" disabled={activeIndex >= chapters.length - 1} onPress={() => chooseChapter(chapters[activeIndex + 1]!.id)} style={[styles.stepButton, { opacity: activeIndex >= chapters.length - 1 ? 0.28 : 1 }]}><Ionicons name="chevron-forward" size={22} color={theme.ink} /></Pressable></View>
          {bookReadingMode === "paged" && pageState?.paged ? <View style={styles.pageProgress}><Pressable accessibilityRole="adjustable" accessibilityLabel="本章阅读进度" accessibilityValue={{ min: 1, max: pageState.spreadCount, now: pageState.spreadIndex + 1 }} onLayout={(event) => setProgressRailWidth(Math.max(1, event.nativeEvent.layout.width))} onPress={(event) => { const ratio = Math.max(0, Math.min(1, event.nativeEvent.locationX / progressRailWidth)); goToSpread(Math.round(ratio * Math.max(0, pageState.spreadCount - 1))); }} style={[styles.progressRail, { backgroundColor: theme.rule }]}><View style={[styles.progressFill, { backgroundColor: theme.red, width: `${pageState.spreadCount <= 1 ? 100 : (pageState.spreadIndex / (pageState.spreadCount - 1)) * 100}%` }]} /><View style={[styles.progressThumb, { backgroundColor: theme.red, left: `${pageState.spreadCount <= 1 ? 100 : (pageState.spreadIndex / (pageState.spreadCount - 1)) * 100}%` }]} /></Pressable><Text style={[styles.pageLabel, { color: theme.muted, fontFamily: theme.sans }]}>{readerStatus} 页</Text></View> : null}
        </View> : null}

        {activeTool === "notes" ? <View style={[styles.toolSheet, styles.fullSheet, { top: insets.top + 64, bottom: sheetBottom, borderColor: theme.ruleDark, backgroundColor: theme.paper }]}>
          <SheetHeader title="划线与笔记" meta={String(bookAnnotations.length)} theme={theme} />
          {bookAnnotations.length === 0 ? <PanelStatus label="还没有划线或笔记" theme={theme} /> : null}
          <FlatList data={bookAnnotations} keyExtractor={(item) => item.id} renderItem={({ item }) => <Pressable onPress={() => locateText(item.chapterId, item.quote)} style={[styles.noteRow, { borderBottomColor: theme.rule }, activeAnnotationId === item.id && { borderLeftColor: theme.red, borderLeftWidth: 3 }]}><Text style={[styles.noteChapter, { color: theme.red, fontFamily: theme.sans }]}>{item.chapterTitle}</Text><Text numberOfLines={3} style={[styles.noteQuote, { color: theme.ink, fontFamily: theme.serif }]}>{item.quote}</Text>{item.note ? <Text style={[styles.noteBody, { color: theme.muted, fontFamily: theme.serif }]}>{item.note}</Text> : null}<View style={styles.noteActions}><Pressable onPress={() => { setNoteComposer({ annotationId: item.id, quote: item.quote }); setNoteDraft(item.note ?? ""); }} hitSlop={8}><Text style={[styles.noteAction, { color: theme.red, fontFamily: theme.sans }]}>编辑</Text></Pressable><Pressable onPress={() => deleteAnnotation(item)} hitSlop={8}><Text style={[styles.noteAction, { color: theme.muted, fontFamily: theme.sans }]}>删除</Text></Pressable></View></Pressable>} />
        </View> : null}

        {activeTool === "text" ? <View style={[styles.toolSheet, styles.displaySheet, { top: insets.top + 64, bottom: sheetBottom, borderColor: theme.ruleDark, backgroundColor: theme.paper }]}><ScrollView contentContainerStyle={styles.displayContent}>
          <SettingGroup label="亮度" theme={theme}><Ionicons name="sunny-outline" size={17} color={theme.muted} /><Slider accessibilityLabel="屏幕亮度" minimumValue={0.05} maximumValue={1} value={brightness} onValueChange={setBrightness} onSlidingComplete={(value) => { void Brightness.setBrightnessAsync(value); }} minimumTrackTintColor={theme.red} maximumTrackTintColor={theme.rule} thumbTintColor={theme.red} style={styles.brightnessSlider} /><Ionicons name="sunny" size={19} color={theme.ink} /></SettingGroup>
          {!IS_EINK_RELEASE ? <SettingGroup label="颜色" theme={theme}>{(["ivory", "white", "dark"] as const).map((value) => <ColorOption key={value} value={value} selected={bookPaperColor === value} onPress={() => choosePaperColor(value)} theme={theme} />)}</SettingGroup> : null}
          <SettingGroup label="字号" theme={theme}>{([{ value: 0.9 as const, label: "小" }, { value: 1 as const, label: "标准" }, { value: 1.12 as const, label: "大" }]).map((option) => <ReaderOption key={option.value} label={option.label} selected={option.value === textScale} onPress={() => chooseTextScale(option.value)} theme={theme} />)}</SettingGroup>
          <SettingGroup label="行距" theme={theme}>{([1.75, 1.95, 2.15] as const).map((value, index) => <ReaderOption key={value} label={["紧凑", "标准", "宽松"][index]!} selected={value === bookLineHeight} onPress={() => chooseLineHeight(value)} theme={theme} />)}</SettingGroup>
          <SettingGroup label="首行" theme={theme}><ReaderOption label="不缩进" selected={!bookFirstLineIndent} onPress={() => chooseFirstLineIndent(false)} theme={theme} /><ReaderOption label="缩进两格" selected={bookFirstLineIndent} onPress={() => chooseFirstLineIndent(true)} theme={theme} /></SettingGroup>
          <SettingGroup label="阅读方式" theme={theme}><ReaderOption label="翻页" selected={bookReadingMode === "paged"} onPress={() => chooseReadingMode("paged")} theme={theme} /><ReaderOption label="滚动" selected={bookReadingMode === "scroll"} onPress={() => chooseReadingMode("scroll")} theme={theme} /></SettingGroup>
        </ScrollView></View> : null}

        <View style={[styles.toolbar, { bottom: insets.bottom, borderTopColor: theme.ruleDark, backgroundColor: theme.paper }]}>{([
          { id: "toc" as const, label: "目录", icon: "list-outline" as const },
          { id: "search" as const, label: "搜索", icon: "search-outline" as const },
          { id: "ai" as const, label: "AI", icon: "sparkles-outline" as const },
          { id: "progress" as const, label: "进度", icon: "radio-button-on-outline" as const },
          { id: "notes" as const, label: "笔记", icon: "create-outline" as const },
          { id: "text" as const, label: "文字", icon: "text-outline" as const },
        ]).map((tool) => { const selected = activeTool === tool.id; return <Pressable key={tool.id} accessibilityRole="button" accessibilityState={{ selected, expanded: selected }} onPress={() => toggleTool(tool.id)} style={styles.toolButton}><Ionicons name={tool.icon} size={20} color={selected ? theme.red : theme.ink} /><Text style={[styles.toolText, { color: selected ? theme.red : theme.ink, fontFamily: theme.sans }]}>{tool.label}</Text></Pressable>; })}</View>
      </> : null}

      {selection ? <View style={[styles.selectionBar, { bottom: sheetBottom, borderColor: theme.ruleDark, backgroundColor: theme.paper }]}><SelectionAction label="复制" icon="copy-outline" theme={theme} onPress={() => { void Clipboard.setStringAsync(selection.text); clearSelection(); }} /><SelectionAction label="划线" icon="remove-outline" theme={theme} onPress={underlineSelection} /><SelectionAction label="笔记" icon="create-outline" theme={theme} onPress={composeSelectionNote} /><SelectionAction label="AI" icon="sparkles-outline" theme={theme} onPress={explainSelection} /></View> : null}
      {noteComposer ? <View style={[styles.noteComposer, { bottom: sheetBottom, borderColor: theme.ruleDark, backgroundColor: theme.paper }]}><Text numberOfLines={2} style={[styles.composerQuote, { color: theme.muted, borderLeftColor: theme.red, fontFamily: theme.serif }]}>{noteComposer.quote}</Text><TextInput autoFocus multiline value={noteDraft} onChangeText={setNoteDraft} placeholder="写想法" placeholderTextColor={theme.muted} style={[styles.noteInput, { color: theme.ink, borderBottomColor: theme.ruleDark, fontFamily: theme.serif }]} /><View style={styles.composerActions}><Pressable onPress={() => { setNoteComposer(undefined); setNoteDraft(""); }}><Text style={[styles.composerButton, { color: theme.muted, fontFamily: theme.sans }]}>取消</Text></Pressable><Pressable disabled={!noteDraft.trim()} onPress={saveNote}><Text style={[styles.composerButton, { color: theme.red, opacity: noteDraft.trim() ? 1 : 0.35, fontFamily: theme.sans }]}>保存</Text></Pressable></View></View> : null}
      {readerNotice ? <Pressable onPress={() => setReaderNotice("")} style={[styles.readerNotice, { top: insets.top + 72, borderColor: theme.red, backgroundColor: theme.paper }]}><Text style={[styles.readerNoticeText, { color: theme.red, fontFamily: theme.sans }]}>{readerNotice}</Text></Pressable> : null}
      <Modal visible={Boolean(expandedImageUri)} transparent={false} animationType="fade" onRequestClose={() => setExpandedImageUri(undefined)}>
        <SafeAreaView edges={["top", "bottom"]} style={[styles.imageModal, { backgroundColor: theme.paper }]}>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭图片" onPress={() => setExpandedImageUri(undefined)} style={styles.imageClose}><Ionicons name="close" size={28} color={theme.ink} /></Pressable>
          {expandedImageUri ? <Image source={{ uri: expandedImageUri }} resizeMode="contain" style={styles.expandedImage} /> : null}
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
  return <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={[styles.scaleButton, { borderColor: selected ? theme.red : theme.rule, backgroundColor: selected ? theme.red : theme.paper }]}><Text style={[styles.scaleButtonText, { color: selected ? theme.inverse : theme.ink, fontFamily: theme.sans }]}>{label}</Text></Pressable>;
}
function ColorOption({ value, selected, onPress, theme }: { value: BookPaperColor; selected: boolean; onPress: () => void; theme: MobileTheme }) {
  const colors = value === "ivory" ? { paper: "#fbfaf6", ink: "#202020", label: "米白" } : value === "white" ? { paper: "#ffffff", ink: "#202020", label: "白色" } : { paper: "#202321", ink: "#deded8", label: "夜间" };
  return <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={[styles.scaleButton, { borderColor: selected ? theme.red : theme.rule, backgroundColor: colors.paper }]}><Text style={[styles.scaleButtonText, { color: colors.ink, fontFamily: theme.sans }]}>{colors.label}</Text></Pressable>;
}
function SelectionAction({ label, icon, theme, onPress }: { label: string; icon: keyof typeof Ionicons.glyphMap; theme: MobileTheme; onPress: () => void }) {
  return <Pressable onPress={onPress} style={styles.selectionAction}><Ionicons name={icon} size={18} color={theme.ink} /><Text style={[styles.selectionActionText, { color: theme.ink, fontFamily: theme.sans }]}>{label}</Text></Pressable>;
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
  chapterStepper: { minHeight: 80, flexDirection: "row", alignItems: "center" }, stepButton: { width: 52, height: 52, alignItems: "center", justifyContent: "center" }, stepCopy: { flex: 1, alignItems: "center", paddingHorizontal: 10 }, stepTitle: { fontSize: 15, fontWeight: "900" }, stepMeta: { marginTop: 5, fontSize: 9, fontWeight: "700" }, pageProgress: { paddingTop: 16 }, progressRail: { height: 4, marginHorizontal: 10, justifyContent: "center" }, progressFill: { position: "absolute", left: 0, height: 4 }, progressThumb: { position: "absolute", width: 18, height: 18, marginLeft: -9 }, pageLabel: { marginTop: 15, textAlign: "center", fontSize: 10, fontWeight: "700" },
  settingGroup: { minHeight: 59, flexDirection: "row", alignItems: "center" }, settingsLabel: { width: 72, fontSize: 10, fontWeight: "800" }, scaleRow: { flex: 1, flexDirection: "row", alignItems: "center", gap: 7 }, scaleButton: { flex: 1, height: 38, borderWidth: 1, alignItems: "center", justifyContent: "center" }, scaleButtonText: { fontSize: 10, fontWeight: "900" }, brightnessSlider: { flex: 1, height: 40 },
  chapterRow: { minHeight: 68, marginHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center", paddingHorizontal: 12 }, chapterNumber: { width: 38, fontSize: 9, fontWeight: "700" }, chapterCopy: { flex: 1 }, chapterRowTitle: { flex: 1, fontSize: 14, fontWeight: "700", lineHeight: 21 }, currentChapter: { marginTop: 3, fontSize: 8, fontWeight: "900" },
  selectionBar: { position: "absolute", zIndex: 7, alignSelf: "center", minWidth: 250, borderWidth: 1, flexDirection: "row", paddingHorizontal: 5 }, selectionAction: { minWidth: 60, height: 54, alignItems: "center", justifyContent: "center", gap: 3 }, selectionActionText: { fontSize: 9, fontWeight: "800" },
  noteComposer: { position: "absolute", zIndex: 8, left: 16, right: 16, borderWidth: 1, padding: 14 }, composerQuote: { borderLeftWidth: 2, paddingLeft: 9, fontSize: 11, lineHeight: 19 }, noteInput: { minHeight: 64, marginTop: 9, borderBottomWidth: 1, paddingVertical: 8, textAlignVertical: "top", fontSize: 13 }, composerActions: { marginTop: 11, flexDirection: "row", justifyContent: "flex-end", gap: 24 }, composerButton: { fontSize: 11, fontWeight: "900" },
  noteRow: { marginHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 14 }, noteChapter: { fontSize: 9, fontWeight: "900" }, noteQuote: { marginTop: 6, fontSize: 13, lineHeight: 21 }, noteBody: { marginTop: 8, fontSize: 11, lineHeight: 19 }, noteActions: { marginTop: 10, flexDirection: "row", justifyContent: "flex-end", gap: 22 }, noteAction: { fontSize: 10, fontWeight: "900" },
  readerNotice: { position: "absolute", zIndex: 9, left: 18, right: 18, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 11 }, readerNoticeText: { fontSize: 11, fontWeight: "800", textAlign: "center" }, imageModal: { flex: 1 }, imageClose: { position: "absolute", zIndex: 2, top: 8, right: 8, width: 52, height: 52, alignItems: "center", justifyContent: "center" }, expandedImage: { flex: 1, width: "100%", height: "100%" },
});
