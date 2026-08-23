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
import { searchArchive, type ArchiveSearchResult } from "../lib/search";
import type { RootStackParamList } from "../navigation/types";
import { useMobileStore } from "../store/mobileStore";
import { mobileTheme, type MobileTheme } from "../theme/tokens";

const PAGE_SIZE = 10;

const SearchResultRow = memo(function SearchResultRow({
  item,
  index,
  theme,
  onPress,
}: {
  item: ArchiveSearchResult;
  index: number;
  theme: MobileTheme;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.title}，${item.date}，第${item.page}版`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.result,
        { borderBottomColor: theme.rule },
        pressed && { backgroundColor: theme.paperSoft },
      ]}
    >
      <Text style={[styles.resultIndex, { color: theme.red, borderBottomColor: theme.red, fontFamily: theme.sans }]}>
        {String(index + 1).padStart(2, "0")}
      </Text>
      <View style={styles.resultCopy}>
        <Text style={[styles.resultTitle, { color: theme.ink, fontFamily: theme.serif }]}>{item.title || "未命名文章"}</Text>
        <View style={styles.tags}>
          <Text style={[styles.tag, { color: theme.red, borderColor: theme.rule, fontFamily: theme.sans }]}>人民日报</Text>
          <Text style={[styles.tag, { color: theme.muted, borderColor: theme.rule, fontFamily: theme.sans }]}>{item.date}</Text>
          {item.page > 0 ? <Text style={[styles.tag, { color: theme.muted, borderColor: theme.rule, fontFamily: theme.sans }]}>第 {item.page} 版</Text> : null}
        </View>
        <Text style={[styles.resultText, { color: theme.muted, fontFamily: theme.serif }]} numberOfLines={3}>{item.content}</Text>
      </View>
    </Pressable>
  );
});

export function SearchScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const hapticsEnabled = useMobileStore((state) => state.hapticsEnabled);
  const theme = mobileTheme;
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [results, setResults] = useState<ArchiveSearchResult[]>([]);
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

  return (
    <SafeAreaView edges={["top"]} style={[styles.safe, { backgroundColor: theme.paper }]}>
      <ScreenHeader title="搜索" />
      <View style={styles.searchRow}>
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
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="搜索"
          disabled={!query.trim() || loading}
          onPress={() => void submit(1)}
          style={({ pressed }) => [
            styles.searchButton,
            { backgroundColor: theme.red, opacity: !query.trim() ? 0.45 : pressed ? 0.78 : 1 },
          ]}
        >
          <Text style={[styles.searchButtonText, { color: theme.inverse, fontFamily: theme.sans }]}>搜索</Text>
        </Pressable>
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
          keyExtractor={(item, index) => `${item.date}:${item.page}:${index}`}
          renderItem={({ item, index }) => (
            <SearchResultRow
              item={item}
              index={(page - 1) * PAGE_SIZE + index}
              theme={theme}
              onPress={() => navigation.navigate("Reader", {
                publication: "rmrb",
                issueId: item.date.replaceAll("-", ""),
                page: item.page || undefined,
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
          removeClippedSubviews
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          overScrollMode={IS_EINK_RELEASE ? "never" : "always"}
        />
      ) : (
        <View style={styles.intro} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  searchRow: { padding: 18, flexDirection: "row", gap: 8 },
  searchBox: { height: 48, flex: 1, borderWidth: 1, justifyContent: "center" },
  input: { height: 46, paddingHorizontal: 13, fontSize: 14 },
  searchButton: { width: 66, height: 48, alignItems: "center", justifyContent: "center" },
  searchButtonText: { fontSize: 13, fontWeight: "900" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  status: { fontSize: 12, fontWeight: "700" },
  message: { margin: 18, borderWidth: 1, padding: 18 },
  messageText: { fontSize: 12 },
  retry: { alignSelf: "flex-start", marginTop: 16, borderWidth: 1, paddingHorizontal: 18, paddingVertical: 10 },
  retryText: { fontSize: 12, fontWeight: "900" },
  results: { paddingHorizontal: 18, paddingBottom: 34 },
  emptyResults: { flexGrow: 1, padding: 18 },
  resultCount: { paddingBottom: 10, fontSize: 11, fontWeight: "700" },
  result: { minHeight: 138, paddingVertical: 18, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", gap: 13 },
  resultIndex: { width: 30, alignSelf: "flex-start", paddingBottom: 5, borderBottomWidth: 2, fontSize: 11, fontWeight: "900" },
  resultCopy: { flex: 1 },
  resultTitle: { fontSize: 18, lineHeight: 25, fontWeight: "900" },
  tags: { marginTop: 8, flexDirection: "row", flexWrap: "wrap", gap: 5 },
  tag: { borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 6, paddingVertical: 3, fontSize: 9, fontWeight: "700" },
  resultText: { marginTop: 8, fontSize: 12, lineHeight: 20 },
  pagination: { paddingTop: 22, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  pageButton: { minWidth: 92, height: 40, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  pageText: { fontSize: 11, fontWeight: "800" },
  pageStatus: { fontSize: 10, fontWeight: "700" },
  emptyText: { marginTop: 60, textAlign: "center", fontSize: 14, lineHeight: 23 },
  intro: { flex: 1 },
});
