import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { MobileBookshelfEntry } from "../account/accountData";
import { useBookshelf } from "../account/useBookshelf";
import { BookCoverCard } from "../components/BookCoverCard";
import { ScreenHeader } from "../components/ScreenHeader";
import { IS_EINK_RELEASE } from "../config/appVariant";
import { loadMobileBooks, type MobileBook } from "../lib/books";
import { REMOVE_CLIPPED_SUBVIEWS } from "../lib/nativePerformance";
import { getLibraryCellWidth, getLibraryColumnCount } from "../lib/tabletLayout";
import type { RootStackParamList } from "../navigation/types";
import { useMobileStore } from "../store/mobileStore";
import { mobileTheme } from "../theme/tokens";
import { useRetryOnFailure } from "../lib/useRetryOnFailure";
import { MobileOfflineBookControl } from "../offline/MobileOfflineBookControl";
import { startMobileOfflineAccountSync, useMobileOfflineBooksStore } from "../offline/books";

type Props = NativeStackScreenProps<RootStackParamList, "Bookshelf">;

type ShelfItem = MobileBookshelfEntry & { book?: MobileBook };

export function BookshelfScreen({ navigation }: Props) {
  const theme = mobileTheme;
  const { width } = useWindowDimensions();
  const recentBooks = useMobileStore((state) => state.recentBooks);
  const { entries, loading, error, busyKey, toggle, reload } = useBookshelf();
  const offlineRecords = useMobileOfflineBooksStore((state) => state.books);
  const offlineLoading = useMobileOfflineBooksStore((state) => state.loading);
  const offlineError = useMobileOfflineBooksStore((state) => state.error);
  const [books, setBooks] = useState<MobileBook[]>([]);
  const [booksFailed, setBooksFailed] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  useRetryOnFailure(booksFailed, () => setRetryToken((value) => value + 1));
  const columnCount = getLibraryColumnCount(width);
  const cellWidth = getLibraryCellWidth(width, columnCount);

  useEffect(startMobileOfflineAccountSync, []);

  useEffect(() => {
    let active = true;
    setBooksFailed(false);
    void loadMobileBooks().then((items) => { if (active) setBooks(items); })
      .catch(() => { if (active) setBooksFailed(true); });
    return () => { active = false; };
  }, [retryToken]);

  const items = useMemo<ShelfItem[]>(() => {
    const visible = [...entries];
    for (const record of offlineRecords) {
      if (!visible.some((entry) => entry.datasetId === record.entry.datasetId && (entry.itemId === record.item.itemId || entry.itemId === record.item.itemKey))) {
        visible.push({ datasetId: record.entry.datasetId, itemId: record.item.itemKey, title: record.item.title });
      }
    }
    return visible.map((entry) => ({ ...entry, book: books.find((book) => book.datasetId === entry.datasetId) }));
  }, [books, entries, offlineRecords]);

  const remove = (item: MobileBookshelfEntry) => toggle(`${item.datasetId}:${item.itemId}`, async () => item);

  return (
    <SafeAreaView edges={["top"]} style={[styles.safe, { backgroundColor: theme.canvas }]}>
      <ScreenHeader title="我的书架" onBack={() => navigation.goBack()} />
      {(loading || offlineLoading) && !items.length ? (
        <View style={styles.center}>
          {!IS_EINK_RELEASE ? <ActivityIndicator color={theme.red} /> : null}
          <Text style={[styles.centerText, { color: theme.muted, fontFamily: theme.sans }]}>正在整理书架…</Text>
        </View>
      ) : (
        <FlatList
          key={`bookshelf-${columnCount}`}
          data={items}
          numColumns={columnCount}
          keyExtractor={(item) => `${item.datasetId}:${item.itemId}`}
          refreshing={loading}
          onRefresh={() => { reload(); setRetryToken((value) => value + 1); }}
          columnWrapperStyle={styles.row}
          contentContainerStyle={[styles.list, !items.length && styles.emptyList]}
          renderItem={({ item }) => {
            const key = `${item.datasetId}:${item.itemId}`;
            const recent = recentBooks.find((entry) => entry.datasetId === item.datasetId && entry.itemKey === item.itemId);
            return (
              <View style={[styles.cell, { width: cellWidth }]}>
                <BookCoverCard
                  book={item.book ?? item.datasetId}
                  itemKey={item.itemId}
                  title={item.title}
                  subtitle={recent?.progress ? `继续阅读 · ${recent.progress}%` : "开始阅读"}
                  onPress={() => navigation.navigate("BookReader", {
                    datasetId: item.datasetId,
                    itemKey: item.itemId,
                    title: item.title,
                    bookTitle: item.book?.title ?? item.title,
                  })}
                />
                <View style={styles.actions}>
                <MobileOfflineBookControl datasetId={item.datasetId} itemKey={item.itemId} title={item.title} />
                {entries.some((entry) => entry.datasetId === item.datasetId && entry.itemId === item.itemId) && <Pressable accessibilityRole="button" accessibilityLabel={`移出书架：${item.title}`} disabled={busyKey === key} onPress={() => void remove(item)} style={styles.removeButton}>
                  <Text style={[styles.removeText, { color: theme.red, opacity: busyKey === key ? 0.4 : 1, fontFamily: theme.sans }]}>{busyKey === key ? "正在移出…" : "移出书架"}</Text>
                </Pressable>}
                </View>
              </View>
            );
          }}
          ListHeaderComponent={(error || offlineError) && items.length ? <Text accessibilityRole="alert" style={[styles.notice, { color: theme.red, borderColor: theme.red, fontFamily: theme.sans }]}>{offlineError || error}</Text> : null}
          ListEmptyComponent={(
            <View style={styles.empty}>
              <Text style={[styles.emptyMark, { color: theme.red, fontFamily: theme.serif }]}>架</Text>
              <Text style={[styles.emptyTitle, { color: theme.ink, fontFamily: theme.serif }]}>{error ? "书架暂时无法载入" : "书架还是空的"}</Text>
              <Text style={[styles.emptyCopy, { color: theme.muted, fontFamily: theme.sans }]}>{error || "从资料库挑一本书，加入后会出现在这里。"}</Text>
              <Pressable onPress={() => navigation.navigate("Tabs", { screen: "Library" })} style={[styles.libraryButton, { backgroundColor: theme.red }]}>
                <Text style={[styles.libraryButtonText, { color: theme.inverse, fontFamily: theme.serif }]}>去资料库选书</Text>
              </Pressable>
            </View>
          )}
          initialNumToRender={columnCount * 3}
          maxToRenderPerBatch={columnCount * 3}
          windowSize={7}
          removeClippedSubviews={REMOVE_CLIPPED_SUBVIEWS}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  centerText: { fontSize: 11, fontWeight: "700" },
  list: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 24, paddingBottom: 40 },
  emptyList: { justifyContent: "center" },
  row: { gap: 16, marginBottom: 24 },
  cell: { flexGrow: 0 },
  actions: { flexDirection: "row", alignItems: "flex-start", gap: 6, marginTop: 4 },
  removeButton: { minHeight: 44, alignItems: "flex-start", justifyContent: "center" },
  removeText: { fontSize: 10 },
  notice: { marginBottom: 18, borderLeftWidth: 2, padding: 10, fontSize: 10, lineHeight: 17, fontWeight: "800" },
  empty: { alignItems: "center", paddingHorizontal: 24 },
  emptyMark: { fontSize: 50, fontWeight: "900" },
  emptyTitle: { marginTop: 12, fontSize: 20, fontWeight: "900" },
  emptyCopy: { marginTop: 8, fontSize: 11, lineHeight: 19, textAlign: "center" },
  libraryButton: { minHeight: 44, marginTop: 20, paddingHorizontal: 20, alignItems: "center", justifyContent: "center" },
  libraryButtonText: { fontSize: 12, fontWeight: "900" },
});
