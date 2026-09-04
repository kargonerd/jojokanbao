import Ionicons from "@expo/vector-icons/Ionicons";
import { ARCHIVE_WEB_ORIGIN } from "@jojo/content";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  loadMobileNotifications,
  loadMobileUnreadNotificationCount,
  markMobileNotificationRead,
  type MobileNotification,
} from "../account/accountData";
import { ScreenHeader } from "../components/ScreenHeader";
import { IS_EINK_RELEASE } from "../config/appVariant";
import type { RootStackParamList } from "../navigation/types";
import { mobileTheme } from "../theme/tokens";

type Props = NativeStackScreenProps<RootStackParamList, "Notifications">;

function displayTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function payloadText(item: MobileNotification, key: string): string {
  return typeof item.payload[key] === "string" ? item.payload[key] as string : "";
}

function safeTargetPath(value: string | null): string | null {
  return value?.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && !/[\r\n]/u.test(value)
    ? value
    : null;
}

function decodedPathParts(pathname: string): string[] {
  try {
    return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    return [];
  }
}

export function NotificationsScreen({ navigation }: Props) {
  const theme = mobileTheme;
  const [items, setItems] = useState<MobileNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      const [loaded, count] = await Promise.all([
        loadMobileNotifications(),
        loadMobileUnreadNotificationCount(),
      ]);
      setItems(loaded);
      setUnreadCount(count);
      setHasMore(loaded.length === 50);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "通知暂时无法读取");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const loadMore = async () => {
    const last = items.at(-1);
    if (!last || loadingMore || !hasMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const loaded = await loadMobileNotifications(50, { id: last.id, createdAt: last.createdAt });
      setItems((current) => [...current, ...loaded.filter((item) => !current.some((entry) => entry.id === item.id))]);
      setHasMore(loaded.length === 50);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "更早通知暂时无法读取");
    } finally {
      setLoadingMore(false);
    }
  };

  const markAllRead = async () => {
    if (!unreadCount) return;
    try {
      await markMobileNotificationRead();
      const now = new Date().toISOString();
      setItems((current) => current.map((item) => item.readAt ? item : { ...item, readAt: now }));
      setUnreadCount(0);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "通知状态更新失败");
    }
  };

  const markOneRead = (item: MobileNotification) => {
    if (item.readAt) return;
    const now = new Date().toISOString();
    setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, readAt: now } : entry));
    setUnreadCount((count) => Math.max(0, count - 1));
    void markMobileNotificationRead(item.id).catch(() => {
      setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, readAt: null } : entry));
      setUnreadCount((count) => count + 1);
      setError("通知状态更新失败");
    });
  };

  const openNotification = (item: MobileNotification) => {
    markOneRead(item);
    const target = safeTargetPath(item.targetPath);
    if (!target) return;
    const pathname = target.split(/[?#]/u)[0] ?? "";
    const parts = decodedPathParts(pathname);
    if (parts[0] === "book" && parts[1] && parts[2]) {
      const contentTitle = payloadText(item, "contentTitle") || "书籍";
      navigation.navigate("BookReader", {
        datasetId: parts[1],
        itemKey: parts[2],
        title: payloadText(item, "sectionTitle") || contentTitle,
        bookTitle: contentTitle,
      });
      return;
    }
    if (parts[0] === "times" && parts[1] && parts[2]) {
      navigation.navigate("TimesDetail", { issueDate: parts[1], newsId: parts[2] });
      return;
    }
    void Linking.openURL(`${ARCHIVE_WEB_ORIGIN.replace(/\/+$/u, "")}${target}`);
  };

  return (
    <SafeAreaView edges={["top"]} style={[styles.safe, { backgroundColor: theme.paper }]}>
      <ScreenHeader title="通知" onBack={() => navigation.goBack()} />
      <View style={[styles.summary, { borderBottomColor: theme.ruleDark }]}>
        <Text style={[styles.summaryText, { color: theme.muted, fontFamily: theme.sans }]}>{unreadCount ? `${unreadCount} 条新消息` : "已经全部读完"}</Text>
        <Pressable accessibilityRole="button" disabled={!unreadCount} onPress={() => void markAllRead()}>
          <Text style={[styles.markAll, { color: theme.red, opacity: unreadCount ? 1 : 0.35, fontFamily: theme.sans }]}>全部标为已读</Text>
        </Pressable>
      </View>
      {loading ? (
        <View style={styles.center}>
          {!IS_EINK_RELEASE ? <ActivityIndicator color={theme.red} /> : null}
          <Text style={[styles.centerText, { color: theme.muted, fontFamily: theme.sans }]}>正在读取通知…</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          refreshing={refreshing}
          onRefresh={() => void load(true)}
          onEndReached={() => void loadMore()}
          onEndReachedThreshold={0.7}
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={7}
          removeClippedSubviews
          contentContainerStyle={[styles.list, !items.length && styles.emptyList]}
          renderItem={({ item }) => {
            const target = safeTargetPath(item.targetPath);
            const actor = item.actorName || "JOJO 编辑部";
            const quote = payloadText(item, "quote");
            const contentTitle = payloadText(item, "contentTitle");
            return (
              <Pressable
                accessibilityRole={target ? "button" : undefined}
                onPress={() => openNotification(item)}
                style={[styles.item, { borderBottomColor: theme.rule, borderLeftColor: item.readAt ? "transparent" : theme.red, backgroundColor: item.readAt ? theme.paper : theme.paperSoft }]}
              >
                <View style={styles.byline}>
                  <Text style={[styles.actor, { color: theme.ink, fontFamily: theme.sans }]}>{actor}</Text>
                  <Text style={[styles.title, { color: theme.ink, fontFamily: theme.serif }]}>{item.title}</Text>
                  {!item.readAt ? <Text style={[styles.newBadge, { color: theme.inverse, backgroundColor: theme.red, fontFamily: theme.sans }]}>新</Text> : null}
                </View>
                {item.body ? <Text style={[styles.body, { color: theme.muted, fontFamily: theme.serif }]}>{item.body}</Text> : null}
                {quote ? <Text numberOfLines={3} style={[styles.quote, { color: theme.muted, borderLeftColor: theme.red, fontFamily: theme.serif }]}>“{quote}”</Text> : null}
                {contentTitle ? <Text numberOfLines={1} style={[styles.contentTitle, { color: theme.red, fontFamily: theme.sans }]}>{contentTitle}</Text> : null}
                <View style={styles.footer}>
                  <Text style={[styles.time, { color: theme.muted, fontFamily: theme.sans }]}>{displayTime(item.createdAt)}</Text>
                  {target ? <Ionicons name="arrow-forward" size={14} color={theme.red} /> : null}
                </View>
              </Pressable>
            );
          }}
          ListEmptyComponent={<Text style={[styles.empty, { color: theme.muted, fontFamily: theme.serif }]}>{error || "还没有通知。"}</Text>}
          ListFooterComponent={items.length ? <Text style={[styles.footerStatus, { color: error ? theme.red : theme.muted, fontFamily: theme.sans }]}>{error || (loadingMore ? "正在读取更早通知…" : hasMore ? "继续上拉读取" : "已经到底了")}</Text> : null}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  summary: { minHeight: 48, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  summaryText: { fontSize: 10, fontWeight: "800" },
  markAll: { fontSize: 10, fontWeight: "900" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  centerText: { fontSize: 11, fontWeight: "700" },
  list: { width: "100%", maxWidth: 760, alignSelf: "center", paddingBottom: 32 },
  emptyList: { flexGrow: 1, justifyContent: "center" },
  item: { borderBottomWidth: StyleSheet.hairlineWidth, borderLeftWidth: 3, paddingHorizontal: 16, paddingVertical: 16 },
  byline: { flexDirection: "row", alignItems: "center", gap: 7 },
  actor: { maxWidth: "35%", fontSize: 10, fontWeight: "900" },
  title: { flex: 1, fontSize: 14, fontWeight: "900" },
  newBadge: { paddingHorizontal: 4, paddingVertical: 1, fontSize: 8, fontWeight: "900" },
  body: { marginTop: 8, fontSize: 12, lineHeight: 20 },
  quote: { marginTop: 9, borderLeftWidth: 2, paddingLeft: 9, fontSize: 11, lineHeight: 19 },
  contentTitle: { marginTop: 9, fontSize: 9, fontWeight: "900" },
  footer: { marginTop: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  time: { fontSize: 8, fontWeight: "700" },
  empty: { textAlign: "center", fontSize: 15, fontWeight: "900" },
  footerStatus: { minHeight: 60, padding: 20, textAlign: "center", fontSize: 9, fontWeight: "700" },
});
