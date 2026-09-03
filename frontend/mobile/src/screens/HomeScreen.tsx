import Ionicons from "@expo/vector-icons/Ionicons";
import { dailyQuote, type ArchivePublicationName } from "@jojo/content";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { publicationImages } from "../components/PeriodicalCoverCard";
import { ScreenHeader } from "../components/ScreenHeader";
import { SectionTitle } from "../components/SectionTitle";
import { IS_EINK_RELEASE } from "../config/appVariant";
import { fuzzyBookTitleScore, loadMobileBookCover, loadMobileBooks, resolveMobileBookOpenTarget, type MobileBook } from "../lib/books";
import { impactHaptic } from "../lib/haptics";
import type { MainTabParamList, RootStackParamList } from "../navigation/types";
import { useMobileStore } from "../store/mobileStore";
import { mobileTheme } from "../theme/tokens";

function RecentReadingCover({
  kind,
  title,
  publication,
  book,
  itemKey,
}: {
  kind: "book" | "periodical";
  title: string;
  publication?: ArchivePublicationName;
  book?: MobileBook;
  itemKey?: string;
}) {
  const theme = mobileTheme;
  const [imageUri, setImageUri] = useState("");
  const [coverMissing, setCoverMissing] = useState(false);

  useEffect(() => {
    let active = true;
    setImageUri("");
    setCoverMissing(false);
    if (kind !== "book" || !book) return () => { active = false; };
    void loadMobileBookCover(book, itemKey)
      .then((uri) => {
        if (!active) return;
        if (uri) setImageUri(uri);
        else setCoverMissing(true);
      })
      .catch(() => { if (active) setCoverMissing(true); });
    return () => { active = false; };
  }, [book, itemKey, kind]);

  if (kind === "periodical" && publication) {
    return (
      <View style={[styles.recentCover, IS_EINK_RELEASE && styles.eInkCover, { borderColor: theme.rule }]}>
        <Image source={publicationImages[publication]} resizeMode="cover" style={styles.recentCoverImage} accessibilityIgnoresInvertColors />
      </View>
    );
  }
  return (
    <View style={[styles.recentCover, IS_EINK_RELEASE && styles.eInkCover, { borderColor: theme.rule, backgroundColor: theme.paperSoft }]}>
      {imageUri ? (
        <Image source={{ uri: imageUri }} resizeMode="cover" style={styles.recentCoverImage} accessibilityIgnoresInvertColors />
      ) : coverMissing ? (
        <Text numberOfLines={4} style={[styles.recentCoverFallback, { color: theme.ink, fontFamily: theme.serif }]}>{title}</Text>
      ) : null}
    </View>
  );
}

export function HomeScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList & MainTabParamList>>();
  const hapticsEnabled = useMobileStore((state) => state.hapticsEnabled);
  const recentIssues = useMobileStore((state) => state.recentIssues);
  const recentBooks = useMobileStore((state) => state.recentBooks);
  const theme = mobileTheme;
  const [query, setQuery] = useState("");
  const [books, setBooks] = useState<MobileBook[]>([]);
  const [loadingBooks, setLoadingBooks] = useState(true);
  const [searchAttempted, setSearchAttempted] = useState(false);
  const quote = useMemo(() => dailyQuote(), []);

  useEffect(() => {
    let active = true;
    void loadMobileBooks()
      .then((items) => { if (active) setBooks(items); })
      .catch(() => undefined)
      .finally(() => { if (active) setLoadingBooks(false); });
    return () => { active = false; };
  }, []);

  const matches = useMemo(() => {
    if (!query.trim()) return [];
    return books
      .map((book) => ({ book, score: fuzzyBookTitleScore(book.title, query) }))
      .filter((result) => Number.isFinite(result.score))
      .sort((left, right) => left.score - right.score)
      .slice(0, 6)
      .map((result) => result.book);
  }, [books, query]);

  const recentItems = useMemo(() => [
    ...recentIssues.map((item) => ({
      kind: "periodical" as const,
      id: `periodical:${item.publication}:${item.issueId}`,
      title: item.title,
      subtitle: item.subtitle,
      progress: item.progress,
      updatedAt: item.updatedAt,
      publication: item.publication,
      issueId: item.issueId,
      page: item.currentPage,
    })),
    ...recentBooks.map((item) => ({
      kind: "book" as const,
      id: `book:${item.datasetId}:${item.itemKey}`,
      title: item.title,
      subtitle: item.subtitle,
      progress: item.progress,
      updatedAt: item.updatedAt,
      datasetId: item.datasetId,
      itemKey: item.itemKey,
      book: books.find((candidate) => candidate.datasetId === item.datasetId),
    })),
  ].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 4), [books, recentBooks, recentIssues]);

  async function openBook(book: MobileBook) {
    void impactHaptic(hapticsEnabled);
    try {
      const target = await resolveMobileBookOpenTarget(book);
      if (target.screen === "BookReader") {
        navigation.navigate("BookReader", {
          datasetId: target.datasetId,
          itemKey: target.itemKey,
          title: target.title,
          bookTitle: target.bookTitle,
        });
      } else {
        navigation.navigate("BookDetails", { book: target.book });
      }
    } catch {
      navigation.navigate("BookDetails", { book });
    }
  }

  function submitSearch() {
    if (matches[0]) {
      openBook(matches[0]);
      return;
    }
    setSearchAttempted(true);
  }

  return (
    <SafeAreaView edges={["top"]} style={[styles.safe, { backgroundColor: theme.canvas }]}>
      <ScreenHeader title="首页" showAccount />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        overScrollMode={IS_EINK_RELEASE ? "never" : "always"}
      >
        <View style={styles.hero}>
          <Text style={[styles.heroTitle, { color: theme.ink, fontFamily: theme.serif }]}>今天读什么？</Text>
          <View style={[styles.searchBox, { borderColor: theme.ruleDark, backgroundColor: theme.paper }]}>
            <Ionicons name="search-outline" size={18} color={theme.muted} />
            <TextInput
              value={query}
              onChangeText={(value) => { setQuery(value); setSearchAttempted(false); }}
              onSubmitEditing={submitSearch}
              placeholder="搜索书名"
              placeholderTextColor={theme.muted}
              returnKeyType="search"
              clearButtonMode="while-editing"
              accessibilityLabel="搜索书名"
              style={[styles.input, { color: theme.ink, fontFamily: theme.sans }]}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="搜索"
              disabled={!query.trim()}
              onPress={submitSearch}
              style={({ pressed }) => [styles.searchButton, { backgroundColor: theme.red, opacity: pressed && !IS_EINK_RELEASE ? 0.78 : 1 }]}
            >
              <Text style={[styles.searchButtonText, { color: theme.inverse, fontFamily: theme.sans }]}>搜索</Text>
            </Pressable>
          </View>

          {query.trim() ? (
            <View style={[styles.matches, { borderColor: theme.rule, backgroundColor: theme.paper }]}>
              {matches.map((book) => (
                <Pressable key={book.datasetId} accessibilityRole="button" onPress={() => void openBook(book)} style={[styles.match, { borderBottomColor: theme.rule }]}>
                  <Text numberOfLines={1} style={[styles.matchTitle, { color: theme.ink, fontFamily: theme.serif }]}>{book.title}</Text>
                </Pressable>
              ))}
              {matches.length === 0 && !loadingBooks ? (
                <Text style={[styles.noMatch, { color: theme.muted, fontFamily: theme.sans }]}>{searchAttempted ? "没有匹配的书籍" : "没有找到相近书名"}</Text>
              ) : null}
            </View>
          ) : null}

          <View accessibilityRole="summary" style={[styles.quote, { borderTopColor: theme.rule }]}>
            <Text style={[styles.quoteText, { color: theme.ink, fontFamily: theme.serif }]}>“{quote.text}”</Text>
            <Text style={[styles.quoteSource, { color: theme.muted, fontFamily: theme.sans }]}>—— {quote.source}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <SectionTitle title="继续阅读" aside="我的书架" onAsidePress={() => navigation.navigate("Library")} />
          {recentItems.length ? recentItems.map((item) => (
            <Pressable
              key={item.id}
              onPress={() => {
                void impactHaptic(hapticsEnabled);
                if (item.kind === "book") {
                  navigation.navigate("BookReader", {
                    datasetId: item.datasetId,
                    itemKey: item.itemKey,
                    title: item.title,
                    bookTitle: item.subtitle,
                  });
                } else {
                  navigation.navigate("Reader", { publication: item.publication, issueId: item.issueId, page: item.page });
                }
              }}
              style={({ pressed }) => [
                styles.recent,
                { backgroundColor: theme.paper },
                pressed && !IS_EINK_RELEASE && styles.recentPressed,
              ]}
            >
              <RecentReadingCover
                kind={item.kind}
                title={item.title}
                publication={item.kind === "periodical" ? item.publication : undefined}
                book={item.kind === "book" ? item.book : undefined}
                itemKey={item.kind === "book" ? item.itemKey : undefined}
              />
              <View style={styles.recentCopy}>
                <Text style={[styles.recentTitle, { color: theme.ink, fontFamily: theme.serif }]}>{item.title}</Text>
                <Text style={[styles.recentSubtitle, { color: theme.muted, fontFamily: theme.sans }]} numberOfLines={1}>{item.subtitle}</Text>
                <View style={[styles.progressTrack, { backgroundColor: theme.rule }]}>
                  <View style={[styles.progressValue, { backgroundColor: theme.red, width: `${item.progress}%` }]} />
                </View>
              </View>
              <Text style={[styles.recentProgress, { color: theme.red, fontFamily: theme.sans }]}>{item.progress}%</Text>
            </Pressable>
          )) : (
            <View style={[styles.empty, { borderColor: theme.rule, backgroundColor: theme.paper }]}>
              <Text style={[styles.emptyGlyph, { color: theme.red, fontFamily: theme.serif }]}>阅</Text>
              <View style={styles.emptyCopy}>
                <Text style={[styles.emptyTitle, { color: theme.ink, fontFamily: theme.serif }]}>还没有阅读记录</Text>
                <Text style={[styles.emptyText, { color: theme.muted, fontFamily: theme.sans }]}>从资料库打开一份报刊或书籍，下一次从这里接着读。</Text>
                <Pressable accessibilityRole="button" onPress={() => navigation.navigate("Library")} hitSlop={8}>
                  <Text style={[styles.emptyAction, { color: theme.red, fontFamily: theme.sans }]}>去资料库 →</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: { minHeight: "100%", padding: 20, paddingTop: 38, paddingBottom: 40 },
  hero: { width: "100%", maxWidth: 640, alignSelf: "center" },
  heroTitle: { marginBottom: 24, fontSize: 32, lineHeight: 42, fontWeight: "500", letterSpacing: -0.8, textAlign: "center" },
  searchBox: { minHeight: 59, borderWidth: 2, paddingLeft: 12, paddingRight: 8, flexDirection: "row", alignItems: "center", gap: 9 },
  input: { height: 54, flex: 1, minWidth: 0, paddingVertical: 0, fontSize: 15 },
  searchButton: { width: 70, height: 40, alignItems: "center", justifyContent: "center" },
  searchButtonText: { fontSize: 12, fontWeight: "900" },
  matches: { marginTop: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12 },
  match: { minHeight: 44, borderBottomWidth: StyleSheet.hairlineWidth, justifyContent: "center" },
  matchTitle: { fontSize: 13, fontWeight: "800" },
  noMatch: { paddingVertical: 15, fontSize: 11 },
  quote: { marginTop: 17, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 13, gap: 6 },
  quoteText: { fontSize: 13, lineHeight: 22 },
  quoteSource: { alignSelf: "flex-end", fontSize: 10, lineHeight: 16 },
  section: { width: "100%", maxWidth: 1100, alignSelf: "center", marginTop: 38 },
  recent: { minHeight: 110, marginTop: 14, padding: 14, flexDirection: "row", alignItems: "center", gap: 14 },
  recentPressed: { opacity: 0.82, transform: [{ translateY: -2 }] },
  recentCover: { width: 68, minHeight: 82, aspectRatio: 0.7, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  recentCoverImage: { width: "100%", height: "100%" },
  eInkCover: { filter: "grayscale(1) contrast(1.15)" },
  recentCoverFallback: { paddingHorizontal: 5, fontSize: 9, lineHeight: 13, fontWeight: "900", textAlign: "center" },
  recentCopy: { flex: 1 },
  recentTitle: { fontSize: 15, fontWeight: "900" },
  recentSubtitle: { marginTop: 3, fontSize: 10 },
  recentProgress: { fontSize: 10, fontWeight: "800" },
  progressTrack: { height: 2, marginTop: 8 },
  progressValue: { height: 2 },
  empty: { marginTop: 14, minHeight: 138, borderWidth: 1, padding: 16, flexDirection: "row", alignItems: "center", gap: 16 },
  emptyGlyph: { width: 48, height: 58, borderWidth: 1, textAlign: "center", textAlignVertical: "center", fontSize: 20, fontWeight: "500" },
  emptyCopy: { flex: 1 },
  emptyTitle: { fontSize: 15, fontWeight: "900" },
  emptyText: { marginTop: 4, fontSize: 11, lineHeight: 17 },
  emptyAction: { marginTop: 12, fontSize: 11, fontWeight: "800" },
});
