import Ionicons from "@expo/vector-icons/Ionicons";
import {
  ARCHIVE_CDN_ORIGIN,
  ARCHIVE_PUBLICATION_BY_ID,
  ARCHIVE_PUBLICATION_NAMES,
  ARCHIVE_WEB_ORIGIN,
  archiveWebIssueUrl,
  formatArchiveIssueLabel,
  type ArchivePublicationName,
} from "@jojo/content";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Linking, Pressable, Share, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from "react-native-webview";
import { IS_EINK_RELEASE } from "../config/appVariant";
import { ReaderEnvironment } from "../components/ReaderEnvironment";
import { impactHaptic } from "../lib/haptics";
import { parseArchiveReaderUrl, readerAppearanceScript, readerBootstrapScript } from "../lib/readerBridge";
import type { RootStackParamList } from "../navigation/types";
import { useMobileStore } from "../store/mobileStore";
import { mobileTheme } from "../theme/tokens";

type ReaderScreenProps = NativeStackScreenProps<RootStackParamList, "Reader">;
type ReaderMessage =
  | { type: "page"; current: number; total: number; url?: string }
  | { type: "ready" | "url"; url?: string };

const configuredReaderOrigin = process.env.EXPO_PUBLIC_READER_BASE?.trim() || ARCHIVE_WEB_ORIGIN;

function safeHost(value: string): string {
  try { return new URL(value).host; } catch { return ""; }
}

export function ReaderScreen({ route, navigation }: ReaderScreenProps) {
  const webViewRef = useRef<WebView>(null);
  const hapticsEnabled = useMobileStore((state) => state.hapticsEnabled);
  const textScale = useMobileStore((state) => state.textScale);
  const rememberIssue = useMobileStore((state) => state.rememberIssue);
  const theme = mobileTheme;
  const [publication, setPublication] = useState(route.params.publication);
  const [issueId, setIssueId] = useState(route.params.issueId);
  const [currentPage, setCurrentPage] = useState(Math.max(1, route.params.page || 1));
  const [totalPages, setTotalPages] = useState(0);
  const [currentUrl, setCurrentUrl] = useState(() => archiveWebIssueUrl(
    route.params.publication,
    route.params.issueId,
    route.params.page,
    configuredReaderOrigin,
  ));
  const [loading, setLoading] = useState(true);
  const [readerReady, setReaderReady] = useState(false);
  const publicationInfo = ARCHIVE_PUBLICATION_BY_ID[publication];
  const allowedHosts = useMemo(() => new Set([safeHost(configuredReaderOrigin), safeHost(ARCHIVE_CDN_ORIGIN)]), []);

  useEffect(() => {
    webViewRef.current?.injectJavaScript(readerAppearanceScript({ eInkRelease: IS_EINK_RELEASE, textScale }));
  }, [textScale]);

  useFocusEffect(useCallback(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      navigation.goBack();
      return true;
    });
    return () => subscription.remove();
  }, [navigation]));

  useEffect(() => {
    if (!readerReady || totalPages <= 0) return;
    const timer = setTimeout(() => {
      rememberIssue({
        publication,
        issueId,
        title: publicationInfo.title,
        subtitle: formatArchiveIssueLabel(issueId),
        currentPage,
        totalPages,
      });
    }, 650);
    return () => clearTimeout(timer);
  }, [currentPage, issueId, publication, publicationInfo.title, readerReady, rememberIssue, totalPages]);

  function syncUrl(url: string | undefined) {
    if (!url) return;
    setCurrentUrl(url);
    const parsed = parseArchiveReaderUrl(url);
    if (!parsed || !ARCHIVE_PUBLICATION_NAMES.includes(parsed.publication as ArchivePublicationName)) return;
    setPublication(parsed.publication as ArchivePublicationName);
    setIssueId(parsed.issueId);
  }

  function handleMessage(event: WebViewMessageEvent) {
    try {
      const message = JSON.parse(event.nativeEvent.data) as ReaderMessage;
      syncUrl(message.url);
      if (message.type === "ready") setReaderReady(true);
      if (message.type === "page") {
        if (Number.isFinite(message.current)) setCurrentPage(Math.max(1, message.current));
        if (Number.isFinite(message.total)) setTotalPages(Math.max(0, message.total));
      }
    } catch {
      // Ignore messages that do not use the JOJO bridge contract.
    }
  }

  function handleNavigationChange(state: WebViewNavigation) {
    syncUrl(state.url);
    setLoading(state.loading);
  }

  async function shareIssue() {
    void impactHaptic(hapticsEnabled);
    await Share.share({
      title: `${publicationInfo.title} · ${formatArchiveIssueLabel(issueId)}`,
      message: `${publicationInfo.title} · ${formatArchiveIssueLabel(issueId)}\n${currentUrl}`,
      url: currentUrl,
    });
  }

  return (
    <SafeAreaView edges={["top", "bottom"]} style={[styles.safe, { backgroundColor: theme.paper }]}>
      <ReaderEnvironment />
      <View style={[styles.header, { borderBottomColor: theme.ruleDark, backgroundColor: theme.paper }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="返回" hitSlop={10} onPress={() => navigation.goBack()} style={styles.iconButton}>
          <Ionicons name="chevron-back" size={24} color={theme.ink} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={[styles.headerTitle, { color: theme.ink, fontFamily: theme.serif }]} numberOfLines={1}>{publicationInfo.title}</Text>
          <Text style={[styles.headerMeta, { color: theme.muted, fontFamily: theme.sans }]} numberOfLines={1}>
            {formatArchiveIssueLabel(issueId)}{totalPages ? ` · ${currentPage}/${totalPages}` : ""}
          </Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="分享本期" hitSlop={8} onPress={() => void shareIssue()} style={styles.iconButton}>
          <Ionicons name="share-outline" size={21} color={theme.ink} />
        </Pressable>
        <Pressable accessibilityRole="link" accessibilityLabel="在浏览器中打开" hitSlop={8} onPress={() => void Linking.openURL(currentUrl)} style={styles.iconButton}>
          <Ionicons name="open-outline" size={20} color={theme.ink} />
        </Pressable>
      </View>

      <View style={styles.webShell}>
        <WebView
          ref={webViewRef}
          source={{ uri: currentUrl }}
          originWhitelist={["https://*", "http://*"]}
          injectedJavaScriptBeforeContentLoaded={readerBootstrapScript({ eInkRelease: IS_EINK_RELEASE, textScale })}
          onMessage={handleMessage}
          onNavigationStateChange={handleNavigationChange}
          onLoadStart={() => {
            setReaderReady(false);
            setLoading(true);
          }}
          onLoadEnd={() => setLoading(false)}
          onShouldStartLoadWithRequest={(request) => {
            if (request.url === "about:blank") return true;
            const host = safeHost(request.url);
            if (allowedHosts.has(host)) return true;
            void Linking.openURL(request.url);
            return false;
          }}
          allowsBackForwardNavigationGestures={false}
          allowsInlineMediaPlayback
          cacheEnabled
          cacheMode="LOAD_DEFAULT"
          sharedCookiesEnabled
          thirdPartyCookiesEnabled={false}
          setSupportMultipleWindows={false}
          javaScriptEnabled
          domStorageEnabled
          overScrollMode={IS_EINK_RELEASE ? "never" : "always"}
          contentInsetAdjustmentBehavior="never"
          style={[styles.webView, { backgroundColor: theme.paper }]}
          containerStyle={{ backgroundColor: theme.paper }}
          applicationNameForUserAgent="JOJOKanbaoMobile/1.0"
          renderError={() => (
            <View style={[styles.error, { backgroundColor: theme.paper }]}>
              <Ionicons name="cloud-offline-outline" size={34} color={theme.red} />
              <Text style={[styles.errorTitle, { color: theme.ink, fontFamily: theme.serif }]}>没有当天文档或数据缺失</Text>
              <Pressable onPress={() => webViewRef.current?.reload()} style={[styles.retry, { borderColor: theme.red }]}>
                <Text style={[styles.retryText, { color: theme.red, fontFamily: theme.sans }]}>重新加载</Text>
              </Pressable>
            </View>
          )}
        />
        {loading ? (
          <View pointerEvents="none" style={[styles.loading, { backgroundColor: theme.paper }]}>
            {IS_EINK_RELEASE ? null : <ActivityIndicator color={theme.red} />}
            <Text style={[styles.loadingText, { color: theme.muted, fontFamily: theme.sans }]}>正在加载 PDF 文档</Text>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: { height: 58, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center", paddingHorizontal: 6 },
  iconButton: { width: 40, height: 48, alignItems: "center", justifyContent: "center" },
  headerCopy: { flex: 1, minWidth: 0, paddingHorizontal: 3 },
  headerTitle: { fontSize: 15, fontWeight: "900" },
  headerMeta: { marginTop: 2, fontSize: 9, fontWeight: "600" },
  webShell: { flex: 1 },
  webView: { flex: 1 },
  loading: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { fontSize: 11, fontWeight: "700" },
  error: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  errorTitle: { marginTop: 15, fontSize: 20, fontWeight: "900" },
  retry: { marginTop: 20, borderWidth: 1, paddingHorizontal: 22, paddingVertical: 11 },
  retryText: { fontSize: 12, fontWeight: "900" },
});
