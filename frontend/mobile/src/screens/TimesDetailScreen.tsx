import Ionicons from "@expo/vector-icons/Ionicons";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { ScreenHeader } from "../components/ScreenHeader";
import { NativeSpeechPlayer } from "../reading/SpeechPlayer";
import { mobileSpeechSegments } from "../reading/speech";
import { SOURCE_LOGOS } from "../lib/sourceLogos";
import { IS_EINK_RELEASE } from "../config/appVariant";
import { createTimesArticleDocument } from "../lib/timesArticleDocument";
import {
  explainMobileTimesSelection,
  type MobileTimesExplanationMetadata,
  type MobileTimesTextAnchor,
} from "../lib/timesAgent";
import {
  mobileTimesApi,
  leadTimesImage,
  safeTimesExternalUrl,
  type MobileTimesLanguage,
  type MobileTimesNewsItem,
} from "../lib/times";
import type { RootStackParamList } from "../navigation/types";
import { useMobileStore } from "../store/mobileStore";
import { mobileTheme } from "../theme/tokens";

type Props = NativeStackScreenProps<RootStackParamList, "TimesDetail">;

type ExplanationState = {
  anchor: MobileTimesTextAnchor;
  answer: string;
  status: string;
  error: string;
  metadata?: MobileTimesExplanationMetadata;
};

function visibleExplanation(value: string): string {
  return value.replace("<!-- JOJO_TIMES_COMPLETE -->", "").trim();
}

export function TimesDetailScreen({ route, navigation }: Props) {
  const { issueDate, newsId } = route.params;
  const defaultLanguage = useMobileStore((state) => state.timesLanguage);
  const theme = mobileTheme;
  const cancelExplanation = useRef<(() => void) | undefined>(undefined);
  const [requestedLanguage, setRequestedLanguage] = useState<MobileTimesLanguage>(defaultLanguage);
  const [news, setNews] = useState<MobileTimesNewsItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<MobileTimesTextAnchor | null>(null);
  const [explanation, setExplanation] = useState<ExplanationState | null>(null);

  useEffect(() => () => cancelExplanation.current?.(), []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setSelection(null);
    void mobileTimesApi.getNews(issueDate, newsId, requestedLanguage)
      .then((value) => { if (active) setNews(value); })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "新闻读取失败");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [issueDate, newsId, requestedLanguage]);

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

  function handleWebMessage(event: WebViewMessageEvent) {
    try {
      const payload = JSON.parse(event.nativeEvent.data) as Record<string, unknown>;
      if (payload.type === "selection") {
        const quote = typeof payload.quote === "string" ? payload.quote.trim() : "";
        setSelection(quote ? {
          quote,
          prefix: typeof payload.prefix === "string" ? payload.prefix : undefined,
          suffix: typeof payload.suffix === "string" ? payload.suffix : undefined,
        } : null);
      } else if (payload.type === "link" && typeof payload.url === "string") {
        const url = safeTimesExternalUrl(payload.url);
        if (url) void Linking.openURL(url);
      }
    } catch {
      // Ignore messages that are not emitted by the article bridge.
    }
  }

  function startExplanation() {
    if (!news || !selection) return;
    cancelExplanation.current?.();
    const anchor = selection;
    setSelection(null);
    let answer = "";
    setExplanation({ anchor, answer: "", status: "正在准备…", error: "" });
    cancelExplanation.current = explainMobileTimesSelection(news, anchor, {
      onStatus: (status) => setExplanation((current) => current ? { ...current, status } : current),
      onChunk: (chunk) => {
        answer += chunk;
        setExplanation((current) => current ? { ...current, answer } : current);
      },
      onDone: (metadata, completed) => {
        setExplanation((current) => current ? { ...current, answer: completed, status: "", metadata } : current);
        cancelExplanation.current = undefined;
      },
      onError: (message) => {
        setExplanation((current) => current ? { ...current, status: "", error: message } : current);
        cancelExplanation.current = undefined;
      },
    });
  }

  function closeExplanation() {
    cancelExplanation.current?.();
    cancelExplanation.current = undefined;
    setExplanation(null);
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
        <WebView
          source={{ html: document, baseUrl: "https://reader.jojokanbao.cn/" }}
          originWhitelist={["about:*", "https://reader.jojokanbao.cn"]}
          onMessage={handleWebMessage}
          javaScriptEnabled
          menuItems={[]}
          domStorageEnabled={false}
          cacheEnabled
          setSupportMultipleWindows={false}
          allowsBackForwardNavigationGestures={false}
          overScrollMode={IS_EINK_RELEASE ? "never" : "always"}
          style={[styles.webView, { backgroundColor: theme.paper }]}
        />
      ) : null}

      {selection && !explanation ? (
        <View style={[styles.selectionBar, { borderColor: theme.ruleDark, backgroundColor: theme.paper }]}>
          <Text numberOfLines={1} style={[styles.selectionQuote, { color: theme.muted, fontFamily: theme.serif }]}>“{selection.quote}”</Text>
          <Pressable accessibilityRole="button" onPress={() => { void Clipboard.setStringAsync(selection.quote); setSelection(null); }} style={styles.copyButton}>
            <Ionicons name="copy-outline" size={16} color={theme.red} />
            <Text style={[styles.copyButtonText, { color: theme.red, fontFamily: theme.sans }]}>复制</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={startExplanation} style={[styles.explainButton, { backgroundColor: theme.red }]}>
            <Text style={[styles.explainButtonText, { color: theme.inverse, fontFamily: theme.sans }]}>AI 解释</Text>
          </Pressable>
        </View>
      ) : null}

      {news?.content ? <NativeSpeechPlayer news documentId={`news:${newsId}:${requestedLanguage}`} title={news.title} chapterId={newsId} chapters={[{ id: newsId, title: news.title }]} loadChapter={loadSpeechChapter} hidden={Boolean(selection || explanation || loading)} cover={coverUri ? { uri: coverUri } : SOURCE_LOGOS[news.source.id]} onRead={() => undefined} /> : null}

      <Modal
        visible={Boolean(explanation)}
        transparent
        animationType={IS_EINK_RELEASE ? "none" : "slide"}
        onRequestClose={closeExplanation}
        statusBarTranslucent
      >
        <View style={styles.explanationRoot}>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭 AI 解释" onPress={closeExplanation} style={styles.explanationBackdrop} />
          <SafeAreaView edges={["top", "bottom"]} style={[styles.explanationPanel, { backgroundColor: theme.paper, borderColor: theme.ruleDark }]}>
            <View style={[styles.explanationHeader, { borderBottomColor: theme.ruleDark }]}>
              <View style={[styles.explanationHeadingRule, { borderLeftColor: theme.red }]}>
                <Text style={[styles.explanationTitle, { color: theme.red, fontFamily: theme.serif }]}>AI 解释</Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={closeExplanation} hitSlop={8}>
                <Ionicons name="close" size={24} color={theme.red} />
              </Pressable>
            </View>
            {explanation ? (
              <ScrollView contentContainerStyle={styles.explanationContent} overScrollMode={IS_EINK_RELEASE ? "never" : "always"}>
                <View style={[styles.quoteBox, { borderLeftColor: theme.ruleDark }]}>
                  <Text selectable style={[styles.quoteText, { color: theme.muted, fontFamily: theme.serif }]}>{explanation.anchor.quote}</Text>
                </View>
                {explanation.status ? <Text style={[styles.explanationStatus, { color: theme.red, fontFamily: theme.sans }]}>{explanation.status}</Text> : null}
                {explanation.answer ? <Text selectable style={[styles.explanationAnswer, { color: theme.ink, fontFamily: theme.serif }]}>{visibleExplanation(explanation.answer)}</Text> : null}
                {explanation.error ? <Text style={[styles.explanationError, { color: theme.red, fontFamily: theme.sans }]}>{explanation.error}</Text> : null}
                {explanation.metadata ? (
                  <Text style={[styles.explanationMeta, { color: theme.muted, borderTopColor: theme.rule, fontFamily: theme.sans }]}>已结合 {explanation.metadata.imageCount} 张随文图片</Text>
                ) : null}
              </ScrollView>
            ) : null}
          </SafeAreaView>
        </View>
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
  selectionBar: { position: "absolute", right: 12, bottom: 14, left: 12, minHeight: 52, borderWidth: 1, paddingLeft: 13, flexDirection: "row", alignItems: "center", gap: 10 },
  selectionQuote: { flex: 1, minWidth: 0, fontSize: 11 },
  copyButton: { height: 50, minWidth: 58, alignItems: "center", justifyContent: "center", gap: 2 },
  copyButtonText: { fontSize: 9, fontWeight: "900" },
  explainButton: { height: 50, minWidth: 84, alignItems: "center", justifyContent: "center", paddingHorizontal: 14 },
  explainButtonText: { fontSize: 11, fontWeight: "900" },
  explanationRoot: { flex: 1, alignItems: "flex-end", backgroundColor: "rgba(0,0,0,.24)" },
  explanationBackdrop: { ...StyleSheet.absoluteFillObject },
  explanationPanel: { width: "100%", maxWidth: 460, height: "100%", borderLeftWidth: 1 },
  explanationHeader: { height: 64, borderBottomWidth: 1, paddingHorizontal: 18, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  explanationHeadingRule: { borderLeftWidth: 3, paddingLeft: 12 },
  explanationTitle: { fontSize: 23, fontWeight: "900" },
  explanationContent: { padding: 20, paddingBottom: 48 },
  quoteBox: { borderLeftWidth: 2, paddingLeft: 13 },
  quoteText: { fontSize: 12, lineHeight: 21 },
  explanationStatus: { marginTop: 22, fontSize: 10, lineHeight: 18, fontWeight: "900" },
  explanationAnswer: { marginTop: 20, fontSize: 16, lineHeight: 29 },
  explanationError: { marginTop: 20, fontSize: 12, lineHeight: 21, fontWeight: "700" },
  explanationMeta: { marginTop: 24, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, fontSize: 9 },
});
