import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { formatOfflineBookBytes } from "@jojo/content";
import { mobileTheme as theme } from "../theme/tokens";
import { mobileOfflineBooks, useMobileOfflineBooksStore } from "./books";

export function MobileOfflineBookControl({ datasetId, itemKey, title }: { datasetId: string; itemKey: string; title: string }) {
  const books = useMobileOfflineBooksStore((state) => state.books);
  const book = books.find((book) => book.entry.datasetId === datasetId && (book.item.itemKey === itemKey || book.item.itemId === itemKey));
  const [pending, setPending] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const cancelled = useRef(false);
  async function download() {
    cancelled.current = false;
    setPending(true); setError("");
    try { await mobileOfflineBooks.download({ datasetId, itemKey, title }); }
    catch (reason) { if (!cancelled.current) setError(reason instanceof Error ? reason.message : "下载失败，请重试"); }
    finally { setPending(false); }
  }
  async function remove() {
    if (!book) return;
    cancelled.current = true;
    setRemoving(true); setError("");
    try { await mobileOfflineBooks.remove(book); setExpanded(false); }
    catch { setError("未能删除下载，请重试"); }
    finally { setRemoving(false); }
  }
  const downloading = pending || book?.status === "downloading";
  const progress = book?.total ? Math.min(99, Math.floor(book.completed / book.total * 100)) : 0;
  const failure = error || (book?.status === "failed" ? book.error : "");
  return <View style={styles.container}>
    <View style={styles.row}>
      {book?.status === "ready" ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`可离线：${title}`} accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} style={styles.action}><Ionicons name="checkmark" size={14} color={theme.muted} /><Text style={styles.label}>可离线</Text></Pressable>
      ) : downloading ? (
        <>
          <Text style={[styles.label, styles.pending]}>{book ? `下载中 ${progress}%` : "准备下载…"}</Text>
          {book && <Pressable accessibilityRole="button" accessibilityLabel={`取消下载：${title}`} disabled={removing} onPress={() => void remove()} style={styles.cancel}><Ionicons name="close" size={16} color={theme.muted} /></Pressable>}
        </>
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel={`${book?.status === "failed" ? "重新下载" : "下载"}：${title}`} disabled={removing} onPress={() => void download()} style={styles.action}><Ionicons name="download-outline" size={14} color={theme.muted} /><Text style={styles.label}>{book?.status === "failed" ? "重试下载" : "下载"}</Text></Pressable>
      )}
    </View>
    {downloading && <View accessibilityRole="progressbar" accessibilityLabel={`下载进度：${title}`} accessibilityValue={book ? { min: 0, max: 100, now: progress } : undefined} style={styles.progress}><View style={[styles.progressFill, { width: `${progress}%` }]} /></View>}
    {expanded && book?.status === "ready" && <View style={styles.detail}><Text style={styles.label}>{formatOfflineBookBytes(book.bytes)}</Text><Pressable accessibilityRole="button" accessibilityLabel={`删除下载：${title}`} disabled={removing} onPress={() => void remove()} style={styles.action}><Text style={[styles.label, { color: theme.red }]}>{removing ? "删除中…" : "删除下载"}</Text></Pressable></View>}
    {failure && !downloading ? <Text accessibilityRole="alert" style={styles.error}>{failure}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  container: { flex: 1, minWidth: 0 },
  row: { flexDirection: "row", alignItems: "center", minHeight: 44 },
  action: { flexDirection: "row", alignItems: "center", gap: 5, minHeight: 44 },
  label: { fontFamily: theme.sans, color: theme.muted, fontSize: 11 },
  pending: { color: theme.red },
  cancel: { minWidth: 36, minHeight: 44, alignItems: "center", justifyContent: "center" },
  progress: { height: 2, backgroundColor: theme.rule },
  progressFill: { height: 2, backgroundColor: theme.red },
  detail: { gap: 12, flexDirection: "row", alignItems: "center", flexWrap: "wrap" },
  error: { fontFamily: theme.sans, color: theme.red, fontSize: 10, lineHeight: 16, paddingBottom: 6 },
});
