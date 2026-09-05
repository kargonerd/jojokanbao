import Ionicons from "@expo/vector-icons/Ionicons";
import type { TimesTimelineIndex, TimesTimelinePage, TimesSourceRef } from "@jojo/content";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMobileAuthStore } from "../account/auth";
import { AuthenticatedFeatureGate } from "../components/AuthenticatedFeatureGate";
import { ScreenHeader } from "../components/ScreenHeader";
import { IS_EINK_RELEASE } from "../config/appVariant";
import { impactHaptic, selectionHaptic } from "../lib/haptics";
import { REMOVE_CLIPPED_SUBVIEWS } from "../lib/nativePerformance";
import {
  firstTimesTimelineCursor,
  leadTimesImage,
  mobileTimesApi,
  nextTimesTimelineCursor,
  presentMobileTimesArticle,
  publisherTimesUpdatedAt,
  relativeTimesArticleTime,
  timesSourceName,
  type MobileTimesArticle,
  type TimesTimelineCursor,
} from "../lib/times";
import type { MainTabParamList, RootStackParamList } from "../navigation/types";
import { useMobileStore } from "../store/mobileStore";
import { mobileTheme } from "../theme/tokens";

import { SOURCE_LOGOS } from "../lib/sourceLogos";

function SourceMark({ source, compact = false }: { source: TimesSourceRef; compact?: boolean }) {
  const theme = mobileTheme;
  const logo = SOURCE_LOGOS[source.id];
  const label = timesSourceName(source).replace(/\s+/gu, "").slice(0, 2).toLocaleUpperCase("zh-CN");
  return (
    <View style={[compact ? styles.sourceMarkCompact : styles.sourceMark, { backgroundColor: theme.paper }]}>
      {logo ? (
        <Image source={logo} resizeMode="contain" style={styles.sourceLogo} />
      ) : (
        <Text numberOfLines={1} style={[compact ? styles.sourceMarkTextCompact : styles.sourceMarkText, { color: theme.red, fontFamily: theme.serif }]}>{label}</Text>
      )}
    </View>
  );
}

function TimelineImage({ article, read }: { article: MobileTimesArticle; read: boolean }) {
  const asset = leadTimesImage(article);
  const theme = mobileTheme;
  const [uri, setUri] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!asset) return;
    const controller = new AbortController();
    setUri("");
    setFailed(false);
    void mobileTimesApi.loadAssetDataUri(asset, controller.signal)
      .then(setUri)
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [asset]);

  if (!asset || failed) return null;
  return (
    <View style={[styles.timelineImage, { backgroundColor: theme.canvas }]}>
      {uri ? <Image source={{ uri }} resizeMode="cover" style={[styles.timelineImageContent, read && styles.readImage]} /> : null}
    </View>
  );
}

function TimelineRow({
  article,
  read,
  onPress,
}: {
  article: MobileTimesArticle;
  read: boolean;
  onPress(): void;
}) {
  const theme = mobileTheme;
  const updated = publisherTimesUpdatedAt(article);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`打开：${article.title}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.timelineRow,
        { backgroundColor: pressed && !IS_EINK_RELEASE ? theme.canvas : theme.paper, borderBottomColor: theme.rule },
      ]}
    >
      <SourceMark source={article.source} />
      <View style={[styles.timelineCopy, read && styles.readCopy]}>
        <View style={styles.timelineMetaRow}>
          <Text numberOfLines={1} style={[styles.timelineSource, { color: read ? theme.muted : theme.red, fontFamily: theme.sans }]}>{timesSourceName(article.source)}</Text>
          {article.usingTranslation ? <Text style={[styles.tag, { borderColor: theme.red, color: theme.red, fontFamily: theme.sans }]}>AI 翻译</Text> : null}
          {updated ? <Text style={[styles.updated, { color: theme.red, fontFamily: theme.sans }]}>已更新</Text> : null}
          <Text style={[styles.timelineTime, { color: theme.muted, fontFamily: theme.sans }]}>{relativeTimesArticleTime(article.publishedAt)}</Text>
        </View>
        <Text numberOfLines={2} style={[styles.timelineTitle, { color: read ? theme.muted : theme.ink, fontFamily: theme.serif }]}>{article.title}</Text>
        {article.summary ? <Text numberOfLines={3} style={[styles.timelineSummary, { color: theme.muted, fontFamily: theme.serif }]}>{article.summary}</Text> : null}
      </View>
      <TimelineImage article={article} read={read} />
    </Pressable>
  );
}

export function TimesScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList & MainTabParamList>>();
  const initialized = useMobileAuthStore((state) => state.initialized);
  const user = useMobileAuthStore((state) => state.user);
  const language = useMobileStore((state) => state.timesLanguage);
  const readIds = useMobileStore((state) => state.timesReadArticleIds);
  const markRead = useMobileStore((state) => state.markTimesArticleRead);
  const disabledSourceIds = useMobileStore((state) => state.timesDisabledSourceIds);
  const hapticsEnabled = useMobileStore((state) => state.hapticsEnabled);
  const theme = mobileTheme;
  const generation = useRef(0);
  const loadingMoreRef = useRef(false);
  const [index, setIndex] = useState<TimesTimelineIndex | null>(null);
  const [pages, setPages] = useState<TimesTimelinePage[]>([]);
  const [nextCursor, setNextCursor] = useState<TimesTimelineCursor | null>(null);
  const [selectedSource, setSelectedSource] = useState("all");
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const readSet = useMemo(() => new Set(readIds), [readIds]);
  const disabledSources = useMemo(() => new Set(disabledSourceIds), [disabledSourceIds]);
  const enabledSources = useMemo(() => (
    index?.sources.filter((source) => !disabledSources.has(source.id)) ?? []
  ), [disabledSources, index?.sources]);
  const articles = useMemo(() => pages
    .flatMap((page) => page.articles)
    .filter((article) => !disabledSources.has(article.source.id))
    .filter((article) => selectedSource === "all" || article.source.id === selectedSource)
    .map((article) => presentMobileTimesArticle(article, language)), [disabledSources, language, pages, selectedSource]);
  const selectedSourceItem = index?.sources.find((source) => source.id === selectedSource);
  const selectedSourceLabel = selectedSourceItem ? timesSourceName(selectedSourceItem) : "所有媒体";

  const loadInitial = useCallback(async (refresh: boolean) => {
    const currentGeneration = ++generation.current;
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      if (refresh) mobileTimesApi.invalidate();
      const loadedIndex = await mobileTimesApi.timelineIndex(refresh);
      const first = firstTimesTimelineCursor(loadedIndex);
      const date = first ? loadedIndex.dates[first.dateIndex] : undefined;
      const page = first && date ? await mobileTimesApi.timelinePage(date.date, first.page, refresh) : null;
      if (currentGeneration !== generation.current) return;
      setIndex(loadedIndex);
      setPages(page ? [page] : []);
      setNextCursor(first ? nextTimesTimelineCursor(loadedIndex, first) : null);
    } catch (reason) {
      if (currentGeneration === generation.current) {
        setError(reason instanceof Error ? reason.message : "时事数据暂时不可用");
      }
    } finally {
      if (currentGeneration === generation.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    if (user) void loadInitial(false);
  }, [loadInitial, user]);

  useEffect(() => {
    if (selectedSource !== "all" && disabledSources.has(selectedSource)) setSelectedSource("all");
  }, [disabledSources, selectedSource]);

  const loadMore = useCallback(async () => {
    const cursor = nextCursor;
    if (!index || !cursor || loadingMoreRef.current || refreshing) return;
    const date = index.dates[cursor.dateIndex];
    if (!date) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setError("");
    try {
      const page = await mobileTimesApi.timelinePage(date.date, cursor.page);
      setPages((current) => current.some((candidate) => candidate.date === page.date && candidate.page === page.page)
        ? current
        : [...current, page]);
      setNextCursor(nextTimesTimelineCursor(index, cursor));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "时间线加载失败");
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [index, nextCursor, refreshing]);

  if (!initialized || !user) {
    return (
      <SafeAreaView edges={["top"]} style={[styles.safe, { backgroundColor: theme.canvas }]}>
        <ScreenHeader title="时事" showAccount />
        <AuthenticatedFeatureGate
          initialized={initialized}
          signedIn={Boolean(user)}
          description="登录后可阅读时事时间线、中文译文与随文 AI 解释。"
          onSignIn={() => navigation.navigate("Account")}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={["top"]} style={[styles.safe, { backgroundColor: theme.paper }]}>
      <ScreenHeader title="时事" showAccount />
      <View style={[styles.filterBar, { borderBottomColor: theme.ruleDark, backgroundColor: theme.paper }]}>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            void selectionHaptic(hapticsEnabled);
            setSourcePickerOpen(true);
          }}
          style={styles.filterButton}
        >
          {selectedSourceItem ? <SourceMark source={selectedSourceItem} compact /> : <Ionicons name="grid-outline" size={21} color={theme.red} />}
          <Text numberOfLines={1} style={[styles.filterLabel, { color: theme.ink, fontFamily: theme.serif }]}>{selectedSourceLabel}</Text>
          <Text style={[styles.filterAction, { color: theme.red, fontFamily: theme.sans }]}>筛选</Text>
          <Ionicons name="chevron-down" size={14} color={theme.red} />
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.loadingState}>
          {!IS_EINK_RELEASE ? <ActivityIndicator color={theme.red} /> : null}
          <Text style={[styles.loadingStateText, { color: theme.muted, fontFamily: theme.sans }]}>正在加载新闻…</Text>
        </View>
      ) : (
        <FlatList
          data={articles}
          keyExtractor={(article) => article.id}
          renderItem={({ item }) => (
            <TimelineRow
              article={item}
              read={readSet.has(item.id)}
              onPress={() => {
                void impactHaptic(hapticsEnabled);
                markRead(item.id);
                navigation.navigate("TimesDetail", { issueDate: item.issueDate, newsId: item.id });
              }}
            />
          )}
          contentContainerStyle={[styles.timeline, !articles.length && styles.emptyTimeline]}
          overScrollMode={IS_EINK_RELEASE ? "never" : "always"}
          onEndReached={() => void loadMore()}
          onEndReachedThreshold={0.8}
          refreshing={refreshing}
          onRefresh={() => void loadInitial(true)}
          initialNumToRender={8}
          maxToRenderPerBatch={8}
          windowSize={7}
          removeClippedSubviews={REMOVE_CLIPPED_SUBVIEWS}
          ListEmptyComponent={!error ? <Text style={[styles.emptyText, { color: theme.muted, fontFamily: theme.serif }]}>暂无文章</Text> : null}
          ListFooterComponent={(
            <View style={styles.timelineFooter}>
              {loadingMore ? <Text style={[styles.footerText, { color: theme.muted, fontFamily: theme.sans }]}>正在加载更多…</Text> : null}
              {error ? (
                <Pressable accessibilityRole="button" onPress={() => nextCursor ? void loadMore() : void loadInitial(false)} style={[styles.retry, { borderColor: theme.red }]}>
                  <Text style={[styles.retryText, { color: theme.red, fontFamily: theme.sans }]}>{error} · 点击重试</Text>
                </Pressable>
              ) : null}
              {!nextCursor && articles.length ? <Text style={[styles.footerText, { color: theme.muted, fontFamily: theme.sans }]}>已经到底了</Text> : null}
            </View>
          )}
        />
      )}

      <Modal
        visible={sourcePickerOpen}
        transparent
        animationType={IS_EINK_RELEASE ? "none" : "fade"}
        onRequestClose={() => setSourcePickerOpen(false)}
        statusBarTranslucent
      >
        <View style={styles.modalRoot}>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭媒体筛选" onPress={() => setSourcePickerOpen(false)} style={styles.modalBackdrop} />
          <SafeAreaView edges={["bottom"]} style={[styles.sourceSheet, { backgroundColor: theme.paper, borderColor: theme.ruleDark }]}>
            <View style={[styles.sourceSheetHeader, { borderBottomColor: theme.ruleDark }]}>
              <Text style={[styles.sourceSheetTitle, { color: theme.ink, fontFamily: theme.serif }]}>选择媒体</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={() => setSourcePickerOpen(false)}>
                <Ionicons name="close" size={23} color={theme.red} />
              </Pressable>
            </View>
            <FlatList
              data={[{ id: "all", name: "所有媒体", language: "" }, ...enabledSources]}
              keyExtractor={(source) => source.id}
              renderItem={({ item }) => {
                const selected = item.id === selectedSource;
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => {
                      void selectionHaptic(hapticsEnabled);
                      setSelectedSource(item.id);
                      setSourcePickerOpen(false);
                    }}
                    style={[styles.sourceRow, { borderBottomColor: theme.rule, borderLeftColor: selected ? theme.red : "transparent" }]}
                  >
                    {item.id === "all" ? <Ionicons name="grid-outline" size={22} color={theme.red} /> : <SourceMark source={item} compact />}
                    <Text numberOfLines={1} style={[styles.sourceName, { color: selected ? theme.red : theme.ink, fontFamily: theme.serif }]}>{timesSourceName(item)}</Text>
                    {selected ? <Ionicons name="checkmark" size={18} color={theme.red} /> : null}
                  </Pressable>
                );
              }}
            />
          </SafeAreaView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  filterBar: { height: 46, borderBottomWidth: 1, flexDirection: "row" },
  filterButton: { flex: 1, minWidth: 0, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 9 },
  filterLabel: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: "900" },
  filterAction: { fontSize: 10, fontWeight: "900" },
  loadingState: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingStateText: { fontSize: 11 },
  timeline: { width: "100%", maxWidth: 760, alignSelf: "center" },
  emptyTimeline: { flexGrow: 1, justifyContent: "center" },
  timelineRow: { minHeight: 112, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 13, flexDirection: "row", alignItems: "flex-start", gap: 11 },
  timelineCopy: { flex: 1, minWidth: 0 },
  readCopy: { opacity: 0.68 },
  timelineMetaRow: { minHeight: 18, flexDirection: "row", alignItems: "center", gap: 6 },
  timelineSource: { flex: 1, minWidth: 0, fontSize: 10, fontWeight: "900" },
  timelineTime: { fontSize: 9, fontWeight: "700" },
  updated: { fontSize: 8, fontWeight: "900" },
  tag: { borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 4, paddingVertical: 1, fontSize: 8, fontWeight: "900" },
  timelineTitle: { marginTop: 4, fontSize: 15, lineHeight: 21, fontWeight: "900" },
  timelineSummary: { marginTop: 4, fontSize: 11, lineHeight: 17 },
  sourceMark: { width: 40, height: 40, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  sourceMarkCompact: { width: 25, height: 25, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  sourceLogo: { width: "100%", height: "100%" },
  sourceMarkText: { fontSize: 12, fontWeight: "900" },
  sourceMarkTextCompact: { fontSize: 8, fontWeight: "900" },
  timelineImage: { width: 96, aspectRatio: 4 / 3, overflow: "hidden", alignSelf: "center" },
  timelineImageContent: { width: "100%", height: "100%" },
  readImage: { opacity: 0.55 },
  timelineFooter: { minHeight: 74, alignItems: "center", justifyContent: "center", padding: 14 },
  footerText: { fontSize: 10 },
  retry: { borderWidth: 1, paddingHorizontal: 14, paddingVertical: 9 },
  retryText: { fontSize: 10, lineHeight: 16, fontWeight: "800", textAlign: "center" },
  emptyText: { fontSize: 18, fontWeight: "900", textAlign: "center" },
  modalRoot: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,.24)" },
  modalBackdrop: { ...StyleSheet.absoluteFillObject },
  sourceSheet: { width: "100%", maxHeight: "76%", borderTopWidth: 1 },
  sourceSheetHeader: { height: 56, borderBottomWidth: 1, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sourceSheetTitle: { fontSize: 19, fontWeight: "900" },
  sourceRow: { minHeight: 52, borderBottomWidth: StyleSheet.hairlineWidth, borderLeftWidth: 3, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", gap: 12 },
  sourceName: { flex: 1, fontSize: 13, fontWeight: "800" },
});
