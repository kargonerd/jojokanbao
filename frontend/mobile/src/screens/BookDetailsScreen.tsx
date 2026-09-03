import Ionicons from "@expo/vector-icons/Ionicons";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BookCoverCard } from "../components/BookCoverCard";
import { IS_EINK_RELEASE } from "../config/appVariant";
import { fuzzyBookTitleScore, loadMobileBookVolumes, type MobileBookVolume } from "../lib/books";
import { impactHaptic } from "../lib/haptics";
import { getLibraryCellWidth, getLibraryColumnCount } from "../lib/tabletLayout";
import type { RootStackParamList } from "../navigation/types";
import { useMobileStore } from "../store/mobileStore";
import { mobileTheme } from "../theme/tokens";

type Props = NativeStackScreenProps<RootStackParamList, "BookDetails">;

export function BookDetailsScreen({ route, navigation }: Props) {
  const { book } = route.params;
  const { width: viewportWidth } = useWindowDimensions();
  const theme = mobileTheme;
  const hapticsEnabled = useMobileStore((state) => state.hapticsEnabled);
  const [query, setQuery] = useState("");
  const [volumes, setVolumes] = useState<MobileBookVolume[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const columnCount = getLibraryColumnCount(viewportWidth);
  const cellWidth = getLibraryCellWidth(viewportWidth, columnCount);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void loadMobileBookVolumes(book)
      .then((items) => {
        if (!active) return;
        setVolumes(items);
        setError("");
      })
      .catch(() => { if (active) setError("这套书的分卷目录暂时无法载入。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [book]);

  const visibleVolumes = useMemo(() => volumes.filter((volume) => (
    !query.trim() || Number.isFinite(fuzzyBookTitleScore(volume.title, query))
  )), [query, volumes]);
  const featuredVolume = viewportWidth >= 700 && !loading && !error && !query.trim() && visibleVolumes.length === 1;
  const listColumnCount = featuredVolume ? 1 : columnCount;

  return (
    <SafeAreaView edges={["top"]} style={[styles.safe, { backgroundColor: theme.paper }]}>
      <View style={[styles.header, { borderBottomColor: theme.ruleDark, backgroundColor: theme.paper }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="返回书籍" hitSlop={10} onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="chevron-back" size={23} color={theme.ink} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={[styles.backLabel, { color: theme.red, fontFamily: theme.sans }]}>返回书籍</Text>
          <Text numberOfLines={1} style={[styles.headerTitle, { color: theme.ink, fontFamily: theme.serif }]}>{book.title}</Text>
        </View>
      </View>
      {loading || volumes.length > 1 ? (
        <View style={[styles.search, { borderColor: theme.ruleDark, backgroundColor: theme.paper }]}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="搜索本书分卷"
            placeholderTextColor={theme.muted}
            returnKeyType="search"
            clearButtonMode="while-editing"
            accessibilityLabel="搜索本书分卷"
            style={[styles.input, { color: theme.ink, fontFamily: theme.sans }]}
          />
        </View>
      ) : null}
      {error ? <Text accessibilityRole="alert" style={[styles.notice, { color: theme.red, borderColor: theme.rule, fontFamily: theme.sans }]}>{error}</Text> : null}
      <FlatList
        key={`volumes-${listColumnCount}`}
        data={visibleVolumes}
        numColumns={listColumnCount}
        keyExtractor={(item) => item.itemId}
        renderItem={({ item }) => (
          <View style={[styles.cell, featuredVolume && styles.featuredCell, { width: featuredVolume ? Math.min(viewportWidth - 36, 900) : cellWidth }]}>
            <BookCoverCard
              book={book}
              itemKey={item.itemKey}
              title={item.title}
              subtitle="打开阅读"
              layout={featuredVolume ? "featured" : "grid"}
              onPress={() => {
                void impactHaptic(hapticsEnabled);
                navigation.navigate("BookReader", {
                  datasetId: book.datasetId,
                  itemKey: item.itemKey,
                  title: item.title,
                  bookTitle: book.title,
                });
              }}
            />
          </View>
        )}
        columnWrapperStyle={listColumnCount > 1 ? styles.row : undefined}
        contentContainerStyle={[styles.list, featuredVolume && styles.featuredList]}
        ListHeaderComponent={loading ? (
          <View style={styles.loading}>
            {IS_EINK_RELEASE ? null : <ActivityIndicator color={theme.red} />}
            <Text style={[styles.loadingText, { color: theme.muted, fontFamily: theme.sans }]}>正在整理馆藏</Text>
          </View>
        ) : null}
        ListEmptyComponent={!loading && !error ? <Text style={[styles.empty, { color: theme.muted, fontFamily: theme.sans }]}>没有找到匹配的资料。</Text> : null}
        showsVerticalScrollIndicator={false}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        overScrollMode={IS_EINK_RELEASE ? "never" : "always"}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: { minHeight: 70, paddingHorizontal: 7, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center" },
  backButton: { width: 42, height: 52, alignItems: "center", justifyContent: "center" },
  headerCopy: { flex: 1, paddingRight: 16 },
  backLabel: { fontSize: 9, fontWeight: "800" },
  headerTitle: { marginTop: 3, fontSize: 19, fontWeight: "900" },
  search: { height: 46, marginHorizontal: 20, marginTop: 20, borderWidth: 1, justifyContent: "center" },
  input: { height: 44, paddingHorizontal: 13, fontSize: 13 },
  notice: { marginHorizontal: 20, marginTop: 12, borderWidth: StyleSheet.hairlineWidth, padding: 10, fontSize: 11, lineHeight: 17 },
  list: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 24, paddingBottom: 40 },
  row: { gap: 16, marginBottom: 24 },
  cell: { flexGrow: 0 },
  featuredCell: { alignSelf: "center" },
  featuredList: { justifyContent: "center", paddingBottom: 70 },
  loading: { paddingVertical: 18, alignItems: "center", gap: 8 },
  loadingText: { fontSize: 11, fontWeight: "700" },
  empty: { paddingTop: 58, textAlign: "center", fontSize: 12 },
});
