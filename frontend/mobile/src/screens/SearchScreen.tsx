import { searchResultTitle } from "@jojo/content";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { memo, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ScreenHeader } from "../components/ScreenHeader";
import { IS_EINK_RELEASE } from "../config/appVariant";
import { impactHaptic } from "../lib/haptics";
import { REMOVE_CLIPPED_SUBVIEWS } from "../lib/nativePerformance";
import { searchArchive, type ArchiveSearchResult } from "../lib/search";
import type { RootStackParamList } from "../navigation/types";
import { useMobileStore } from "../store/mobileStore";
import { mobileTheme, type MobileTheme } from "../theme/tokens";

const PAGE_SIZE = 10;

const SearchResultRow = memo(function SearchResultRow({
  item,
  index,
  theme,
  expanded,
  onToggleExpanded,
  onPress,
}: {
  item: ArchiveSearchResult;
  index: number;
  theme: MobileTheme;
  expanded: boolean;
  onToggleExpanded: () => void;
  onPress: () => void;
}) {
  return (
    <View style={[styles.result, { borderBottomColor: theme.rule }]}>
      <Text style={[styles.resultIndex, { color: theme.red, borderBottomColor: theme.red, fontFamily: theme.sans }]}>
        {String(index + 1).padStart(2, "0")}
      </Text>
      <View style={styles.resultCopy}>
        <Pressable accessibilityRole="button" accessibilityLabel={`查看原版 PDF：${item.title || "未命名文章"}`} onPress={onPress}>
          <Text style={[styles.resultTitle, { color: theme.ink, fontFamily: theme.serif }]}>{item.title || "未命名文章"}</Text>
        </Pressable>
        <View style={styles.tags}>
          <Text style={[styles.tag, { color: theme.red, borderColor: theme.rule, fontFamily: theme.sans }]}>人民日报</Text>
          <Text style={[styles.tag, { color: theme.muted, borderColor: theme.rule, fontFamily: theme.sans }]}>{item.date}</Text>
          {item.page > 0 ? <Text style={[styles.tag, { color: theme.muted, borderColor: theme.rule, fontFamily: theme.sans }]}>第 {item.page} 版</Text> : null}
        </View>
        <Text
          selectable={expanded}
          style={[styles.resultText, { color: expanded ? theme.ink : theme.muted, fontFamily: theme.serif }]}
          numberOfLines={expanded ? undefined : 3}
        >{item.content.trim() ? item.content : "暂无文字内容，可查看原版 PDF。"}</Text>
        <View style={styles.resultActions}>
          {item.content.trim() ? (
            <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={onToggleExpanded} style={styles.resultAction}>
              <Text style={[styles.resultActionText, { color: theme.red, fontFamily: theme.sans }]}>{expanded ? "收起全文" : "显示全文"}</Text>
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="button" onPress={onPress} style={styles.resultAction}>
            <Text style={[styles.resultActionText, { color: theme.red, fontFamily: theme.sans }]}>查看原版 PDF</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
});

export function SearchScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const hapticsEnabled = useMobileStore((state) => state.hapticsEnabled);
  const theme = mobileTheme;
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [results, setResults] = useState<ArchiveSearchResult[]>([]);
  const [expandedResults, setExpandedResults] = useState<Set<number>>(() => new Set());
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const controllerRef = useRef<AbortController | null>(null);
  const listRef = useRef<FlatList<ArchiveSearchResult>>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  async function submit(nextPage = 1, keywordOverride?: string) {
    const keyword = (keywordOverride ?? (nextPage === 1 ? query : submittedQuery)).trim();
    if (!keyword) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError("");
    void impactHaptic(hapticsEnabled);
    try {
      const response = await searchArchive({ keyword, page: nextPage, size: PAGE_SIZE, signal: controller.signal });
      if (controller.signal.aborted) return;
      setSubmittedQuery(keyword);
      setResults(response.results);
      setExpandedResults(new Set());
      setTotal(response.total);
      setPage(nextPage);
      requestAnimationFrame(() => {
        listRef.current?.scrollToOffset({ offset: 0, animated: !IS_EINK_RELEASE });
      });
    } catch {
      if (!controller.signal.aborted) setError("搜索失败，请检查网络后重试。");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const beforeSearch = !submittedQuery && !loading && !error;

  return (
    <SafeAreaView edges={["top"]} style={[styles.safe, { backgroundColor: theme.canvas }]}>
      <ScreenHeader title="搜索" showAccount />
      <View style={[styles.searchArea, beforeSearch ? styles.searchAreaIdle : styles.searchAreaResults]}>
        <View style={[styles.searchBox, { borderColor: theme.ruleDark, backgroundColor: theme.paper }]}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={() => void submit(1)}
            placeholder="在JOJO看报上搜索"
            placeholderTextColor={theme.muted}
            returnKeyType="search"
            clearButtonMode="while-editing"
            autoCorrect={false}
            style={[styles.input, { color: theme.ink, fontFamily: theme.sans }]}
            accessibilityLabel="在JOJO看报上搜索"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="搜索"
            disabled={!query.trim() || loading}
            onPress={() => void submit(1)}
            style={({ pressed }) => [
              styles.searchButton,
              { backgroundColor: theme.red, opacity: pressed && !IS_EINK_RELEASE ? 0.78 : 1 },
            ]}
          >
            <Text style={[styles.searchButtonText, { color: theme.inverse, fontFamily: theme.sans }]}>搜索</Text>
          </Pressable>
        </View>
      </View>

      {loading ? (
        <View style={styles.center}>
          {IS_EINK_RELEASE ? null : <ActivityIndicator color={theme.red} />}
          <Text style={[styles.status, { color: theme.muted, fontFamily: theme.sans }]}>搜索中</Text>
        </View>
      ) : error ? (
        <View style={[styles.message, { borderColor: theme.red }]}>
          <Text style={[styles.messageText, { color: theme.muted, fontFamily: theme.sans }]}>{error}</Text>
          <Pressable onPress={() => void submit(page, submittedQuery || query)} style={[styles.retry, { borderColor: theme.red }]}>
            <Text style={[styles.retryText, { color: theme.red, fontFamily: theme.sans }]}>重试</Text>
          </Pressable>
        </View>
      ) : submittedQuery ? (
        <FlatList
          ref={listRef}
          data={results}
          extraData={expandedResults}
          keyExtractor={(item, index) => `${item.date}:${item.page}:${index}`}
          renderItem={({ item, index }) => (
            <SearchResultRow
              item={item}
              index={(page - 1) * PAGE_SIZE + index}
              theme={theme}
              expanded={expandedResults.has(index)}
              onToggleExpanded={() => setExpandedResults((previous) => {
                const next = new Set(previous);
                if (next.has(index)) next.delete(index);
                else next.add(index);
                return next;
              })}
              onPress={() => navigation.navigate("Reader", {
                publication: "rmrb",
                issueId: item.date.replaceAll("-", ""),
                page: item.page || undefined,
                searchQuery: submittedQuery,
                searchTitle: searchResultTitle(item.title),
              })}
            />
          )}
          contentContainerStyle={[
            results.length ? styles.results : styles.emptyResults,
            { paddingBottom: 24 },
          ]}
          ListHeaderComponent={(
            <Text style={[styles.resultCount, { color: theme.muted, fontFamily: theme.sans }]}>“{submittedQuery}” · {total} 条结果</Text>
          )}
          ListEmptyComponent={(
            <Text style={[styles.emptyText, { color: theme.muted, fontFamily: theme.serif }]}>没有找到相关结果</Text>
          )}
          ListFooterComponent={results.length ? (
            <View style={{ paddingBottom: 24 }}>
              <View style={styles.pagination}>
                <Pressable disabled={page <= 1} onPress={() => void submit(page - 1)} style={[styles.pageButton, { borderColor: theme.ruleDark, opacity: page <= 1 ? 0.35 : 1 }]}>
                  <Text style={[styles.pageText, { color: theme.ink, fontFamily: theme.sans }]}>← 上一页</Text>
                </Pressable>
                <Text style={[styles.pageStatus, { color: theme.muted, fontFamily: theme.sans }]}>{page} / {totalPages}</Text>
                <Pressable disabled={page >= totalPages} onPress={() => void submit(page + 1)} style={[styles.pageButton, { borderColor: theme.ruleDark, opacity: page >= totalPages ? 0.35 : 1 }]}>
                  <Text style={[styles.pageText, { color: theme.ink, fontFamily: theme.sans }]}>下一页 →</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
          initialNumToRender={8}
          maxToRenderPerBatch={6}
          windowSize={7}
          removeClippedSubviews={REMOVE_CLIPPED_SUBVIEWS}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          overScrollMode={IS_EINK_RELEASE ? "never" : "always"}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  searchArea: { width: "100%", maxWidth: 680, alignSelf: "center", paddingHorizontal: 20 },
  searchAreaIdle: { flex: 1, justifyContent: "center", paddingBottom: 58 },
  searchAreaResults: { paddingTop: 20, paddingBottom: 20 },
  searchBox: { minHeight: 59, borderWidth: 2, paddingLeft: 12, paddingRight: 8, flexDirection: "row", alignItems: "center", gap: 8 },
  input: { height: 54, flex: 1, minWidth: 0, paddingVertical: 0, fontSize: 15 },
  searchButton: { width: 70, height: 40, alignItems: "center", justifyContent: "center" },
  searchButtonText: { fontSize: 12, fontWeight: "900" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  status: { fontSize: 12, fontWeight: "700" },
  message: { marginHorizontal: 20, borderWidth: 1, padding: 18 },
  messageText: { fontSize: 12 },
  retry: { alignSelf: "flex-start", marginTop: 16, borderWidth: 1, paddingHorizontal: 18, paddingVertical: 10 },
  retryText: { fontSize: 12, fontWeight: "900" },
  results: { paddingHorizontal: 20, paddingBottom: 40 },
  emptyResults: { flexGrow: 1, paddingHorizontal: 20 },
  resultCount: { paddingBottom: 10, fontSize: 11, fontWeight: "700" },
  result: { minHeight: 138, paddingVertical: 18, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", gap: 13 },
  resultIndex: { width: 30, alignSelf: "flex-start", paddingBottom: 5, borderBottomWidth: 2, fontSize: 11, fontWeight: "900" },
  resultCopy: { flex: 1 },
  resultTitle: { fontSize: 18, lineHeight: 25, fontWeight: "900" },
  tags: { marginTop: 8, flexDirection: "row", flexWrap: "wrap", gap: 5 },
  tag: { borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 6, paddingVertical: 3, fontSize: 9, fontWeight: "700" },
  resultText: { marginTop: 8, fontSize: 14, lineHeight: 24 },
  resultActions: { flexDirection: "row", flexWrap: "wrap", columnGap: 24 },
  resultAction: { minHeight: 44, justifyContent: "center" },
  resultActionText: { fontSize: 12, fontWeight: "800" },
  pagination: { paddingTop: 22, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  pageButton: { minWidth: 92, height: 40, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  pageText: { fontSize: 11, fontWeight: "800" },
  pageStatus: { fontSize: 10, fontWeight: "700" },
  emptyText: { marginTop: 60, textAlign: "center", fontSize: 14, lineHeight: 23 },
});
