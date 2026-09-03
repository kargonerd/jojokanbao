import Ionicons from "@expo/vector-icons/Ionicons";
import {
  ARCHIVE_PUBLICATIONS,
  dateToIssueId,
  getLatestRmrbAvailableDate,
  isArchiveNewspaperIssueAvailable,
  issueIdToDate,
  type ArchivePublicationSummary,
} from "@jojo/content";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BookCoverCard } from "../components/BookCoverCard";
import { IssueDateModal } from "../components/IssueDateModal";
import { PeriodicalCoverCard } from "../components/PeriodicalCoverCard";
import { ScreenHeader } from "../components/ScreenHeader";
import { IS_EINK_RELEASE } from "../config/appVariant";
import {
  fuzzyBookTitleScore,
  loadMobileBooks,
  type MobileBook,
} from "../lib/books";
import { impactHaptic } from "../lib/haptics";
import { getLibraryCellWidth, getLibraryColumnCount } from "../lib/tabletLayout";
import type { RootStackParamList } from "../navigation/types";
import { useMobileStore } from "../store/mobileStore";
import { mobileTheme } from "../theme/tokens";

type LibraryType = "all" | "periodical" | "book";
type LibraryItem =
  | { kind: "periodical"; publication: ArchivePublicationSummary }
  | { kind: "book"; book: MobileBook };

const libraryTypes: Array<{ id: LibraryType; label: string; icon: keyof typeof Ionicons.glyphMap }> = [
  { id: "all", label: "全部", icon: "grid-outline" },
  { id: "periodical", label: "报刊", icon: "newspaper-outline" },
  { id: "book", label: "书籍", icon: "book-outline" },
];

const newspaperBounds = {
  rmrb: { min: "19460515", max: () => getLatestRmrbAvailableDate() },
  ckxx: { min: "19570301", max: () => "19981231" },
} as const;

export function LibraryScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { width: viewportWidth } = useWindowDimensions();
  const hapticsEnabled = useMobileStore((state) => state.hapticsEnabled);
  const theme = mobileTheme;
  const [type, setType] = useState<LibraryType>("all");
  const [query, setQuery] = useState("");
  const [books, setBooks] = useState<MobileBook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [datePublication, setDatePublication] = useState<ArchivePublicationSummary | null>(null);
  const [selectedDate, setSelectedDate] = useState(issueIdToDate(getLatestRmrbAvailableDate()));
  const columnCount = getLibraryColumnCount(viewportWidth);
  const cellWidth = getLibraryCellWidth(viewportWidth, columnCount);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void loadMobileBooks()
      .then((items) => {
        if (!active) return;
        setBooks(items);
        setError("");
      })
      .catch(() => {
        if (active) setError("书籍目录暂时无法载入，报刊仍可正常使用。");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const items = useMemo<LibraryItem[]>(() => {
    const matches = (title: string) => !query.trim() || Number.isFinite(fuzzyBookTitleScore(title, query));
    const result: LibraryItem[] = [];
    if (type === "all" || type === "periodical") {
      result.push(...ARCHIVE_PUBLICATIONS
        .filter((publication) => matches(publication.title))
        .map((publication) => ({ kind: "periodical" as const, publication })));
    }
    if (type === "all" || type === "book") {
      result.push(...books
        .filter((book) => matches(book.title))
        .map((book) => ({ kind: "book" as const, book })));
    }
    return result;
  }, [books, query, type]);

  function openPeriodical(publication: ArchivePublicationSummary, issueId: string) {
    void impactHaptic(hapticsEnabled);
    navigation.navigate("Reader", { publication: publication.id, issueId });
  }

  function pickDate(publication: ArchivePublicationSummary) {
    if (publication.id !== "rmrb" && publication.id !== "ckxx") return;
    const initial = publication.id === "rmrb" ? getLatestRmrbAvailableDate() : publication.defaultIssueId;
    setSelectedDate(issueIdToDate(initial));
    setDatePublication(publication);
  }

  function openBook(book: MobileBook) {
    void impactHaptic(hapticsEnabled);
    navigation.navigate("BookDetails", { book });
  }

  const bounds = datePublication?.id === "rmrb" || datePublication?.id === "ckxx"
    ? newspaperBounds[datePublication.id]
    : newspaperBounds.rmrb;
  const busy = loading;

  return (
    <SafeAreaView edges={["top"]} style={[styles.safe, { backgroundColor: theme.canvas }]}>
      <ScreenHeader title="资料库" showAccount />
      <View accessibilityRole="tablist" style={[styles.types, { borderBottomColor: theme.rule, backgroundColor: theme.paper }]}>
          {libraryTypes.map((item) => {
            const selected = item.id === type;
            return (
              <Pressable
                key={item.id}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                onPress={() => { setType(item.id); setQuery(""); }}
                style={[styles.typeButton, selected && { borderBottomColor: theme.red, borderBottomWidth: 2 }]}
              >
                <Ionicons name={item.icon} size={18} color={selected ? theme.red : theme.ink} />
                <Text style={[styles.typeText, { color: selected ? theme.red : theme.muted, fontFamily: theme.sans }]}>{item.label}</Text>
              </Pressable>
            );
          })}
      </View>

      <View style={[styles.search, { borderColor: theme.ruleDark, backgroundColor: theme.paper }]}>
        <Ionicons name="search-outline" size={18} color={theme.muted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="搜索报刊或书名"
          placeholderTextColor={theme.muted}
          returnKeyType="search"
          clearButtonMode="while-editing"
          style={[styles.input, { color: theme.ink, fontFamily: theme.sans }]}
          accessibilityLabel="搜索馆藏"
        />
      </View>

      {error ? <Text accessibilityRole="alert" style={[styles.notice, { color: theme.red, borderColor: theme.rule, fontFamily: theme.sans }]}>{error}</Text> : null}
      <FlatList
        key={`library-${columnCount}`}
        data={items}
        numColumns={columnCount}
        keyExtractor={(item) => item.kind === "periodical"
          ? `periodical:${item.publication.id}`
          : `book:${item.book.datasetId}`}
        renderItem={({ item }) => (
          <View style={[styles.cell, { width: cellWidth }]}>
            {item.kind === "periodical" ? (
              <PeriodicalCoverCard
                publication={item.publication}
                onOpen={() => openPeriodical(item.publication, item.publication.id === "rmrb" ? getLatestRmrbAvailableDate() : item.publication.defaultIssueId)}
                onPickDate={item.publication.type === "newspaper" ? () => pickDate(item.publication) : undefined}
              />
            ) : (
              <BookCoverCard
                book={item.book}
                title={item.book.title}
                subtitle={item.book.itemCount && item.book.itemCount > 1
                  ? `${item.book.itemCount} 册 · 选择分册`
                  : "单册 · 直接阅读"}
                onPress={() => openBook(item.book)}
              />
            )}
          </View>
        )}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.list}
        ListEmptyComponent={!busy ? <Text style={[styles.empty, { color: theme.muted, fontFamily: theme.sans }]}>没有找到匹配的资料。</Text> : null}
        ListHeaderComponent={busy ? (
          <View style={styles.loading}>
            {IS_EINK_RELEASE ? null : <ActivityIndicator color={theme.red} />}
            <Text style={[styles.loadingText, { color: theme.muted, fontFamily: theme.sans }]}>正在整理馆藏</Text>
          </View>
        ) : null}
        showsVerticalScrollIndicator={false}
        initialNumToRender={columnCount * 3}
        maxToRenderPerBatch={columnCount * 3}
        windowSize={7}
        removeClippedSubviews
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        overScrollMode={IS_EINK_RELEASE ? "never" : "always"}
      />
      <IssueDateModal
        publication={datePublication}
        value={selectedDate}
        minimumDate={issueIdToDate(bounds.min)}
        maximumDate={issueIdToDate(bounds.max())}
        isDateAvailable={(date) => datePublication?.id === "rmrb" || datePublication?.id === "ckxx"
          ? isArchiveNewspaperIssueAvailable(datePublication.id, dateToIssueId(date))
          : false}
        onChange={setSelectedDate}
        onClose={() => setDatePublication(null)}
        onConfirm={() => {
          if (!datePublication) return;
          const publication = datePublication;
          setDatePublication(null);
          openPeriodical(publication, dateToIssueId(selectedDate));
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  types: { height: 65, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row" },
  typeButton: { height: 65, flex: 1, gap: 3, alignItems: "center", justifyContent: "center", borderBottomColor: "transparent" },
  typeText: { fontSize: 12, lineHeight: 16, fontWeight: "800" },
  search: { height: 53, marginHorizontal: 20, marginTop: 28, borderWidth: 1, paddingHorizontal: 13, flexDirection: "row", alignItems: "center", gap: 9 },
  input: { height: 51, flex: 1, minWidth: 0, paddingVertical: 0, fontSize: 14 },
  notice: { marginHorizontal: 20, marginTop: 12, borderLeftWidth: 2, padding: 10, fontSize: 11, lineHeight: 17 },
  list: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 28, paddingBottom: 40 },
  row: { gap: 16, marginBottom: 24 },
  cell: { flexGrow: 0 },
  loading: { paddingVertical: 18, alignItems: "center", gap: 8 },
  loadingText: { fontSize: 11, fontWeight: "700" },
  empty: { paddingTop: 58, textAlign: "center", fontSize: 12 },
});
