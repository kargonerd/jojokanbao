import Ionicons from "@expo/vector-icons/Ionicons";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Clipboard from "expo-clipboard";
import type { ReaderSelectionRect } from "@jojo/ui/reader-selection";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { ScreenHeader } from "../components/ScreenHeader";
import { TimesExplanationPanel } from "../components/TimesExplanationPanel";
import { ReaderSelectionToolbar } from "../components/ReaderSelectionToolbar";
import { FeedbackSheet, type FeedbackCorrection } from "../components/FeedbackSheet";
import { BookThoughtComposer } from "../components/BookThoughtComposer";
import { AnnotationDiscussionPanel } from "../annotations/AnnotationDiscussionPanel";
import {
  addAnnotationComment,
  createAnnotation,
  deleteMyAnnotationMark,
  loadAnnotationThreads,
  reportAnnotationComment,
  type AnnotationSubject,
  type AnnotationThread,
  type AnnotationVisibility,
  type TextAnchor,
} from "../annotations/api";
import { useMobileAuthStore } from "../account/auth";
import { NativeSpeechPlayer } from "../reading/SpeechPlayer";
import { mobileSpeechSegments } from "../reading/speech";
import { SOURCE_LOGOS } from "../lib/sourceLogos";
import { IS_EINK_RELEASE } from "../config/appVariant";
import {
  createTimesApplyAnnotationsScript,
  createTimesArticleDocument,
  createTimesImageDocument,
  createTimesRemoveAnnotationScript,
} from "../lib/timesArticleDocument";
import {
  explainMobileTimesSelection,
  type MobileTimesExplanationMetadata,
  type MobileTimesTextAnchor,
} from "../lib/timesAgent";
import {
  mobileTimesApi,
  leadTimesImage,
  timesSourceName,
  safeTimesExternalUrl,
  type MobileTimesLanguage,
  type MobileTimesNewsItem,
} from "../lib/times";
import type { RootStackParamList } from "../navigation/types";
import { useMobileStore } from "../store/mobileStore";
import { mobileTheme } from "../theme/tokens";
import { useRetryOnFailure } from "../lib/useRetryOnFailure";
import { useReaderExplanation } from "../lib/useReaderExplanation";

type Props = NativeStackScreenProps<RootStackParamList, "TimesDetail">;

type ArticleSelection = MobileTimesTextAnchor & {
  start?: number;
  end?: number;
  rect?: ReaderSelectionRect;
  viewport?: { width: number; height: number };
};

function anchorFromSelection(selection: ArticleSelection): TextAnchor {
  return {
    quote: selection.quote,
    prefix: selection.prefix ?? "",
    suffix: selection.suffix ?? "",
    startOffset: Number.isInteger(selection.start) ? selection.start! : 0,
    endOffset: Number.isInteger(selection.end) ? selection.end! : 0,
  };
}

export function TimesDetailScreen({ route, navigation }: Props) {
  const { issueDate, newsId } = route.params;
  const defaultLanguage = useMobileStore((state) => state.timesLanguage);
  const user = useMobileAuthStore((state) => state.user);
  const theme = mobileTheme;
  const webViewRef = useRef<WebView>(null);
  const [readerFrame, setReaderFrame] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const [expandedImage, setExpandedImage] = useState<{ url: string; caption: string } | null>(null);
  const [requestedLanguage, setRequestedLanguage] = useState<MobileTimesLanguage>(defaultLanguage);
  const [news, setNews] = useState<MobileTimesNewsItem | null>(null);
  const [threads, setThreads] = useState<AnnotationThread[]>([]);
  const [annotationBusy, setAnnotationBusy] = useState(false);
  const [annotationNotice, setAnnotationNotice] = useState("");
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [thoughtComposer, setThoughtComposer] = useState<{ quote: string; anchor: TextAnchor } | null>(null);
  const [thoughtDraft, setThoughtDraft] = useState("");
  const [thoughtVisibility, setThoughtVisibility] = useState<AnnotationVisibility>("public");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retryToken, setRetryToken] = useState(0);
  useRetryOnFailure(Boolean(error) && !loading, () => setRetryToken((value) => value + 1));
  const [selection, setSelection] = useState<ArticleSelection | null>(null);
  const [correction, setCorrection] = useState<FeedbackCorrection>();
  const explanationChat = useReaderExplanation<MobileTimesTextAnchor, MobileTimesExplanationMetadata>(
    (anchor, callbacks, request) => explainMobileTimesSelection(news!, anchor, callbacks, request),
    `${issueDate}:${newsId}:${requestedLanguage}:${retryToken}`,
  );
  const explanation = explanationChat.conversation;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setSelection(null);
    setExpandedImage(null);
    void mobileTimesApi.getNews(issueDate, newsId, requestedLanguage)
      .then((value) => { if (active) setNews(value); })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "新闻读取失败");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [issueDate, newsId, requestedLanguage, retryToken]);

  const document = useMemo(
    () => news ? createTimesArticleDocument(news, IS_EINK_RELEASE) : "",
    [news],
  );
  const originalUrl = safeTimesExternalUrl(news?.url);
  const leadImage = news ? leadTimesImage(news) : undefined;
  const coverUri = leadImage ? news?.assetUrls?.[leadImage.id] : undefined;
  const loadSpeechChapter = useCallback(async () => {
    if (!news?.content) throw new Error("这篇新闻暂无可朗读的正文");
    return { id: newsId, title: news.title, segments: mobileSpeechSegments(news.title, news.content, news.contentFormat ?? "text") };
  }, [news, newsId]);

  const annotationSubject: AnnotationSubject | null = useMemo(() => news ? {
    contentType: "newspaper",
    contentId: newsId,
    sectionId: "body",
    contentTitle: news.title,
    contentUrl: `/times/${newsId}`,
  } : null, [news, newsId]);
  const activeThread = threads.find((thread) => thread.id === activeThreadId);

  const refreshAnnotations = useCallback(async () => {
    if (!annotationSubject || !user) { setThreads([]); return; }
    try {
      setThreads(await loadAnnotationThreads(annotationSubject));
    } catch (reason) {
      setAnnotationNotice(reason instanceof Error ? reason.message : "笔记暂时无法读取");
    }
  }, [annotationSubject, user]);

  useEffect(() => { void refreshAnnotations(); }, [refreshAnnotations]);

  // Article changes swap the WebView document, so underline markers are applied
  // again on every load; the bridge ignores calls that arrive before it exists.
  const renderAnnotations = useCallback(() => {
    webViewRef.current?.injectJavaScript(createTimesApplyAnnotationsScript(threads.map((thread) => ({
      id: thread.id, start: thread.startOffset ?? 0, end: thread.endOffset ?? 0,
      quote: thread.quote, prefix: thread.prefix, suffix: thread.suffix,
    }))));
  }, [threads]);

  useEffect(() => { renderAnnotations(); }, [renderAnnotations, document]);

  async function underlineSelection() {
    if (!annotationSubject || !selection || annotationBusy) return;
    setAnnotationBusy(true);
    setAnnotationNotice("");
    try {
      await createAnnotation(annotationSubject, anchorFromSelection(selection));
      clearSelection();
      await refreshAnnotations();
      setAnnotationNotice("已划线");
    } catch (reason) {
      setAnnotationNotice(reason instanceof Error ? reason.message : "划线失败，请重试。");
    } finally {
      setAnnotationBusy(false);
    }
  }

  function composeThought() {
    if (!selection) return;
    setThoughtComposer({ quote: selection.quote, anchor: anchorFromSelection(selection) });
    setThoughtDraft("");
    setThoughtVisibility("public");
    clearSelection();
  }

  async function saveThought() {
    if (!annotationSubject || !thoughtComposer || annotationBusy || !thoughtDraft.trim()) return;
    setAnnotationBusy(true);
    setAnnotationNotice("");
    try {
      await createAnnotation(annotationSubject, thoughtComposer.anchor, thoughtDraft.trim(), thoughtVisibility);
      setThoughtComposer(null);
      setThoughtDraft("");
      await refreshAnnotations();
    } catch (reason) {
      setAnnotationNotice(reason instanceof Error ? reason.message : "保存失败，请重试。");
    } finally {
      setAnnotationBusy(false);
    }
  }

  async function removeUnderline(thread: AnnotationThread) {
    if (annotationBusy) return;
    setAnnotationBusy(true);
    try {
      await deleteMyAnnotationMark(thread.id);
      webViewRef.current?.injectJavaScript(createTimesRemoveAnnotationScript(thread.id));
      setActiveThreadId(null);
      await refreshAnnotations();
    } catch (reason) {
      setAnnotationNotice(reason instanceof Error ? reason.message : "删除划线失败，请重试。");
    } finally {
      setAnnotationBusy(false);
    }
  }

  async function commentOnThread(thread: AnnotationThread, body: string, parentCommentId?: string, visibility?: AnnotationVisibility) {
    try {
      await addAnnotationComment(thread.id, body, parentCommentId, visibility);
      await refreshAnnotations();
    } catch (reason) {
      setAnnotationNotice(reason instanceof Error ? reason.message : "评论失败，请重试。");
    }
  }

  function handleWebMessage(event: WebViewMessageEvent) {
    try {
      const payload = JSON.parse(event.nativeEvent.data) as Record<string, unknown>;
      if (payload.type === "selection") {
        const quote = typeof payload.quote === "string" ? payload.quote.trim() : "";
        const rect = payload.rect as ReaderSelectionRect | undefined;
        const viewport = payload.viewport as ArticleSelection["viewport"];
        const validGeometry = rect && viewport && [rect.left, rect.right, rect.top, rect.bottom, viewport.width, viewport.height].every(Number.isFinite)
          && viewport.width > 0 && viewport.height > 0;
        setSelection(quote ? {
          quote,
          prefix: typeof payload.prefix === "string" ? payload.prefix : undefined,
          suffix: typeof payload.suffix === "string" ? payload.suffix : undefined,
          ...(typeof payload.start === "number" ? { start: payload.start } : {}),
          ...(typeof payload.end === "number" ? { end: payload.end } : {}),
          ...(validGeometry ? { rect, viewport } : {}),
        } : null);
      } else if (payload.type === "annotation" && typeof payload.id === "string") {
        setActiveThreadId(payload.id);
        clearSelection();
      } else if (payload.type === "image" && typeof payload.assetId === "string") {
        const asset = news?.assets.find((item) => item.id === payload.assetId && item.type === "image");
        const url = asset ? news?.assetUrls?.[asset.id] : undefined;
        if (asset && url) {
          clearSelection();
          setExpandedImage({ url, caption: typeof payload.caption === "string" ? payload.caption : asset.caption || asset.alt || "" });
        }
      } else if (payload.type === "link" && typeof payload.url === "string") {
        const url = safeTimesExternalUrl(payload.url);
        if (url) void Linking.openURL(url);
      }
    } catch {
      // Ignore messages that are not emitted by the article bridge.
    }
  }

  function clearSelection() {
    setSelection(null);
    webViewRef.current?.injectJavaScript("window.getSelection()?.removeAllRanges(); true;");
  }

  function startExplanation() {
    if (!news || !selection) return;
    clearSelection();
    explanationChat.start(selection);
  }

  function composeCorrection() {
    if (!news || !selection) return;
    setCorrection({
      quote: selection.quote,
      contentType: "times_article",
      contentId: newsId,
      contentTitle: news.title,
    });
    clearSelection();
  }

  return (
    <SafeAreaView edges={["top", "bottom"]} style={[styles.safe, { backgroundColor: theme.paper }]}>
      <ScreenHeader title="时事" onBack={() => navigation.goBack()} />
      {news?.translationAvailable || originalUrl ? (
        <View style={[styles.actionBar, { borderBottomColor: theme.rule, backgroundColor: theme.paper }]}>
          {news?.translationAvailable ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setRequestedLanguage(news.usingTranslation ? "original" : "zh-CN")}
              style={styles.actionButton}
            >
              <Ionicons name="language-outline" size={16} color={theme.red} />
              <Text style={[styles.actionText, { color: theme.red, fontFamily: theme.sans }]}>{news.usingTranslation ? "查看原文" : "查看中文译文"}</Text>
            </Pressable>
          ) : <View />}
          {originalUrl ? (
            <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(originalUrl)} style={styles.actionButton}>
              <Text style={[styles.actionText, { color: theme.red, fontFamily: theme.sans }]}>出版方原文</Text>
              <Ionicons name="open-outline" size={15} color={theme.red} />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {loading ? (
        <View style={styles.centerState}>
          {!IS_EINK_RELEASE ? <ActivityIndicator color={theme.red} /> : null}
          <Text style={[styles.centerText, { color: theme.muted, fontFamily: theme.sans }]}>正在读取全文和图片…</Text>
        </View>
      ) : error ? (
        <View style={styles.centerState}>
          <View style={[styles.errorBox, { borderColor: theme.red }]}>
            <Text style={[styles.errorText, { color: theme.red, fontFamily: theme.sans }]}>{error}</Text>
            <Pressable accessibilityRole="button" onPress={() => setRequestedLanguage((value) => value === "zh-CN" ? "original" : "zh-CN")}>
              <Text style={[styles.retryText, { color: theme.red, fontFamily: theme.sans }]}>切换版本重试</Text>
            </Pressable>
          </View>
        </View>
      ) : news ? (
        <View style={styles.webView} onLayout={(event) => setReaderFrame(event.nativeEvent.layout)}>
          <WebView
            ref={webViewRef}
            source={{ html: document, baseUrl: "https://reader.jojokanbao.cn/" }}
            originWhitelist={["about:*", "https://reader.jojokanbao.cn"]}
            onMessage={handleWebMessage}
            onLoadEnd={renderAnnotations}
            javaScriptEnabled
            menuItems={[]}
            domStorageEnabled={false}
            cacheEnabled
            setSupportMultipleWindows={false}
            allowsBackForwardNavigationGestures={false}
            overScrollMode={IS_EINK_RELEASE ? "never" : "always"}
            style={[styles.webView, { backgroundColor: theme.paper }]}
          />
        </View>
      ) : null}

      {selection && !explanation ? (
        <ReaderSelectionToolbar selection={selection} frame={readerFrame} theme={theme} eInk={IS_EINK_RELEASE}
          onCopy={() => { void Clipboard.setStringAsync(selection.quote); clearSelection(); }}
          onUnderline={user ? () => void underlineSelection() : undefined}
          onThought={user ? composeThought : undefined}
          onReport={composeCorrection} onExplain={() => startExplanation()} />
      ) : null}

      {activeThread && user ? <AnnotationDiscussionPanel key={`${user.id}:${activeThread.id}`} thread={activeThread} currentUserId={user.id} theme={theme}
        onClose={() => setActiveThreadId(null)}
        onRemoveMark={() => removeUnderline(activeThread)}
        onComment={(body, parentId, visibility) => commentOnThread(activeThread, body, parentId, visibility)}
        onReport={(commentId, reason, details) => reportAnnotationComment(commentId, reason, details)} /> : null}

      {thoughtComposer ? <BookThoughtComposer quote={thoughtComposer.quote} value={thoughtDraft} visibility={thoughtVisibility} onVisibilityChange={setThoughtVisibility}
        saving={annotationBusy} error={annotationNotice} onChange={setThoughtDraft}
        onCancel={() => { if (!annotationBusy) { setThoughtComposer(null); setThoughtDraft(""); setAnnotationNotice(""); } }}
        onSave={() => void saveThought()} theme={theme} /> : null}

      {annotationNotice && !thoughtComposer ? <Pressable accessibilityRole="button" onPress={() => setAnnotationNotice("")} style={[styles.annotationNotice, { borderColor: theme.red, backgroundColor: theme.paper }]}><Text style={[styles.annotationNoticeText, { color: theme.red, fontFamily: theme.sans }]}>{annotationNotice}</Text></Pressable> : null}

      <FeedbackSheet visible={Boolean(correction)} correction={correction} screen="times_detail" onClose={() => setCorrection(undefined)} theme={theme} />

      {news?.content ? <NativeSpeechPlayer news documentId={`news:${newsId}:${requestedLanguage}`} title={news.title} sourceName={timesSourceName(news.source)} chapterId={newsId} chapters={[{ id: newsId, title: news.title }]} loadChapter={loadSpeechChapter} hidden={Boolean(selection || explanation || expandedImage || loading)} cover={coverUri ? { uri: coverUri } : undefined} coverFallback={SOURCE_LOGOS[news.source.id]} onRead={() => undefined} /> : null}

      <Modal visible={Boolean(expandedImage)} animationType={IS_EINK_RELEASE ? "none" : "fade"} onRequestClose={() => setExpandedImage(null)}>
        <SafeAreaView edges={["top", "bottom"]} style={[styles.safe, { backgroundColor: theme.paper }]}>
          <ScreenHeader title="图片预览" onBack={() => setExpandedImage(null)} />
          {expandedImage ? <>
            <WebView source={{ html: createTimesImageDocument(expandedImage.url, expandedImage.caption) }} javaScriptEnabled={false} domStorageEnabled={false} setBuiltInZoomControls setDisplayZoomControls={false} style={styles.webView} />
            {expandedImage.caption ? <Text style={[styles.imageCaption, { color: theme.muted, fontFamily: theme.sans }]}>{expandedImage.caption}</Text> : null}
          </> : null}
        </SafeAreaView>
      </Modal>

      <Modal
        visible={Boolean(explanation)}
        transparent
        animationType={IS_EINK_RELEASE ? "none" : "slide"}
        onRequestClose={explanationChat.close}
        statusBarTranslucent
      >
        {explanation ? <TimesExplanationPanel key={explanation.conversationId} {...explanation}
          onClose={explanationChat.close} onRetry={explanationChat.retry} onAsk={explanationChat.ask} onStop={explanationChat.stop} /> : null}
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  actionBar: { minHeight: 42, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  actionButton: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 4 },
  actionText: { fontSize: 10, fontWeight: "900" },
  centerState: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 22 },
  centerText: { fontSize: 11 },
  errorBox: { width: "100%", maxWidth: 520, borderWidth: 2, padding: 18 },
  errorText: { fontSize: 12, lineHeight: 20 },
  retryText: { marginTop: 16, fontSize: 11, fontWeight: "900" },
  webView: { flex: 1 },
  annotationNotice: { position: "absolute", bottom: 28, left: 20, right: 20, alignItems: "center", borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8 },
  annotationNoticeText: { fontSize: 11, fontWeight: "800" },
  imageCaption: { padding: 16, fontSize: 12, lineHeight: 20, textAlign: "center" },
});
