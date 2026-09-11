import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Alert, FlatList, Pressable, Share, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { SCRAPBOOK_PAGE_SIZE, safeScrapbookPath, scrapbookMarkdown, type ScrapbookDraft, type ScrapbookEntry } from "@jojo/auth";
import type { RootStackParamList } from "../navigation/types";
import { useMobileAuthStore } from "../account/auth";
import { mobileTheme as theme } from "../theme/tokens";
import { mobileScrapbook } from "./api";
import { ScrapbookEditor } from "./ScrapbookEditor";
import { openClippingSource } from "./navigation";

export function ScrapbookScreen({ navigation }: NativeStackScreenProps<RootStackParamList, "Scrapbook">) {
  const userId = useMobileAuthStore((state) => state.user?.id);
  const [entries, setEntries] = useState<ScrapbookEntry[]>([]);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [collections, setCollections] = useState<string[]>([]);
  const [collection, setCollection] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<ScrapbookEntry>();
  const generation = useRef(0);
  async function reload(append = false) {
    const owner = userId;
    if (!owner) return;
    const request = ++generation.current; setLoading(true); setError("");
    try {
      const [page, names] = await Promise.all([mobileScrapbook.list(search, collection, append ? entries.length : 0), mobileScrapbook.collections()]);
      if (generation.current !== request || useMobileAuthStore.getState().user?.id !== owner) return;
      setEntries((current) => append ? [...current, ...page.filter((item) => !current.some((old) => old.id === item.id))] : page);
      setCollections(names); setHasMore(page.length === SCRAPBOOK_PAGE_SIZE);
    } catch (reason) { if (generation.current === request && useMobileAuthStore.getState().user?.id === owner) setError(reason instanceof Error ? reason.message : "剪报本加载失败。"); }
    finally { if (generation.current === request) setLoading(false); }
  }
  const reloadLatest = useRef(reload);
  reloadLatest.current = reload;
  useLayoutEffect(() => { setBusy(false); setEntries([]); setCollections([]); setEditing(undefined); setQuery(""); setSearch(""); setCollection(null); }, [userId]);
  useFocusEffect(useCallback(() => {
    ++generation.current; setEntries([]); setCollections([]); setEditing(undefined); setError(""); setLoading(false);
    if (userId) void reload();
    return () => { ++generation.current; };
  }, [userId, search, collection]));
  async function save(value: ScrapbookDraft) {
    const owner = userId; if (!editing || !owner) return;
    setBusy(true); setError("");
    try { await mobileScrapbook.save(value, editing.id); if (useMobileAuthStore.getState().user?.id === owner) { setEditing(undefined); await reloadLatest.current(); } }
    catch (reason) { if (useMobileAuthStore.getState().user?.id === owner) setError(reason instanceof Error ? reason.message : "保存失败。"); }
    finally { if (useMobileAuthStore.getState().user?.id === owner) setBusy(false); }
  }
  async function remove(id: string) {
    const owner = userId; setBusy(true);
    try { await mobileScrapbook.remove(id); if (useMobileAuthStore.getState().user?.id === owner) await reloadLatest.current(); }
    catch { if (useMobileAuthStore.getState().user?.id === owner) setError("删除失败，请重试。"); }
    finally { if (useMobileAuthStore.getState().user?.id === owner) setBusy(false); }
  }
  async function share() {
    const owner = userId; setBusy(true); setError("");
    try {
      const all: ScrapbookEntry[] = [];
      for (let offset = 0; ; offset += SCRAPBOOK_PAGE_SIZE) {
        const page = await mobileScrapbook.list(search, collection, offset);
        if (useMobileAuthStore.getState().user?.id !== owner) return;
        all.push(...page); if (page.length < SCRAPBOOK_PAGE_SIZE) break;
      }
      await Share.share({ title: "JOJO 剪报本", message: scrapbookMarkdown(all) });
    } catch { if (useMobileAuthStore.getState().user?.id === owner) setError("导出失败，请重试。"); }
    finally { if (useMobileAuthStore.getState().user?.id === owner) setBusy(false); }
  }
  return <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
    <View style={styles.header}><Pressable accessibilityRole="button" onPress={() => navigation.goBack()}><Text style={styles.action}>返回</Text></Pressable><Text accessibilityRole="header" style={styles.heading}>剪报本</Text><Pressable accessibilityRole="button" disabled={busy || !entries.length} onPress={() => void share()}><Text style={styles.action}>导出</Text></Pressable></View>
    {!userId ? <View style={styles.empty}><Text style={styles.body}>登录后保存摘录和笔记，并在其他设备查看。</Text><Pressable onPress={() => navigation.navigate("Account")}><Text style={styles.action}>登录</Text></Pressable></View> : <FlatList
      data={entries} keyExtractor={(entry) => entry.id} refreshing={loading} onRefresh={() => void reload()} keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.list}
      ListHeaderComponent={<>
        <View style={styles.search}><TextInput accessibilityLabel="搜索剪报" placeholder="搜索摘录、笔记和书名" placeholderTextColor={theme.muted} value={query} onChangeText={setQuery} onSubmitEditing={() => setSearch(query.trim())} returnKeyType="search" style={styles.input} /><Pressable onPress={() => setSearch(query.trim())}><Text style={styles.action}>搜索</Text></Pressable></View>
        <View style={styles.collections}>{[null, "", ...collections].map((name) => <Pressable key={name === null ? "all" : `collection:${name}`} accessibilityRole="button" accessibilityState={{ selected: name === collection }} onPress={() => setCollection(name)} style={[styles.chip, name === collection && { borderColor: theme.red }]}><Text style={{ color: name === collection ? theme.red : theme.ink }}>{name === null ? "全部专题" : name || "未分类"}</Text></Pressable>)}</View>
        {error ? <View><Text accessibilityRole="alert" style={styles.error}>{error}</Text><Pressable disabled={loading} onPress={() => void reload()}><Text style={styles.action}>重试</Text></Pressable></View> : null}
      </>}
      ListEmptyComponent={!loading && !error ? <View style={styles.empty}><Text style={styles.body}>还没有符合条件的剪报。在阅读页选择“加入剪报本”，摘录和出处会一起保存。</Text></View> : null}
      renderItem={({ item }) => <View style={styles.card}><Text style={styles.title}>{item.contentTitle}</Text><Text style={styles.meta}>{item.locationLabel}{item.collection ? "　" + item.collection : ""}</Text>
        {item.quote ? <Text style={styles.quote}>{item.quote}</Text> : null}{item.note ? <Text style={styles.body}>{item.note}</Text> : null}
        <View style={styles.actions}>{safeScrapbookPath(item.contentUrl) ? <Pressable onPress={() => openClippingSource(navigation, item)}><Text style={styles.action}>返回原文</Text></Pressable> : null}
          <Pressable disabled={busy} onPress={() => { setError(""); setEditing(item); }}><Text style={styles.action}>编辑</Text></Pressable>
          <Pressable disabled={busy} onPress={() => Alert.alert("删除剪报", "这条摘录和笔记将从你的剪报本中删除。", [{ text: "取消", style: "cancel" }, { text: "删除", style: "destructive", onPress: () => void remove(item.id) }])}><Text style={styles.action}>删除</Text></Pressable></View>
      </View>}
      ListFooterComponent={hasMore ? <Pressable disabled={loading} onPress={() => void reload(true)}><Text style={styles.action}>加载更多</Text></Pressable> : null}
    />}
    {editing && <ScrapbookEditor initial={editing} saving={busy} error={error} onSave={(draft) => void save(draft)} onClose={() => setEditing(undefined)} />}
  </SafeAreaView>;
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.paper }, header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderColor: theme.ruleDark, padding: 12 },
  heading: { fontSize: 22, color: theme.ink, fontFamily: theme.serif }, action: { color: theme.red, padding: 10, fontSize: 14 },
  list: { padding: 20 }, search: { flexDirection: "row", alignItems: "center", gap: 8 }, input: { flex: 1, borderWidth: 1, borderColor: theme.ruleDark, color: theme.ink, padding: 10, fontSize: 16 },
  collections: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingVertical: 16 }, chip: { borderWidth: 1, borderColor: theme.rule, padding: 8 },
  empty: { padding: 24 }, body: { fontSize: 15, color: theme.ink, lineHeight: 27, marginBottom: 14 }, card: { borderBottomWidth: 1, borderColor: theme.rule, paddingVertical: 22 },
  title: { fontSize: 20, color: theme.ink, fontFamily: theme.serif }, meta: { fontSize: 12, color: theme.muted, marginVertical: 12 },
  quote: { fontSize: 15, color: theme.ink, lineHeight: 28, borderLeftWidth: 3, borderColor: theme.red, paddingLeft: 14, marginBottom: 18 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, error: { color: theme.red, lineHeight: 24 },
});
