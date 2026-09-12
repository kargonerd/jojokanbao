import { isReadingRecord, startReadingHistorySync, type ReadingRecord, type ReadingHistoryData } from "@jojo/content";
import { useRecentReadingStore, type RecentReadingItem } from "./recentReadingStore";
import { useAccountSessionStore } from "../account/session";

export function recentItemToRecord(item: RecentReadingItem): ReadingRecord | undefined {
  try {
    const url = new URL(item.href, "https://jojokanbao.cn");
    const base = { title: item.title, subtitle: item.subtitle, progress: item.progress, updatedAt: item.updatedAt };
    const parts = url.pathname.split("/").map(decodeURIComponent);
    if (item.kind === "periodical" && parts[1] !== "archive") {
      if (parts[1] === "reader") parts[1] = "archive";
      else parts.splice(1, 0, "archive");
    }
    const record = item.kind === "book" ? {
      ...base, kind: "book", datasetId: item.datasetId || parts[2], itemKey: item.itemKey || parts[3],
      ...(url.searchParams.get("chapter") ? { chapterId: url.searchParams.get("chapter")! } : {}),
      ...(item.chapterProgress !== undefined ? { chapterProgress: item.chapterProgress } : {}),
    } : {
      ...base, kind: "periodical", publication: item.publicationId || parts[2], issueId: parts[3],
      currentPage: Number(/^#page-(\d+)$/.exec(url.hash)?.[1] || 1), totalPages: item.totalPages || 0,
    };
    return isReadingRecord(record) ? record : undefined;
  } catch { return undefined; }
}

export function readingRecordToRecentItem(record: ReadingRecord): RecentReadingItem {
  const base = { title: record.title, subtitle: record.subtitle, progress: record.progress, updatedAt: record.updatedAt };
  if (record.kind === "book") {
    const query = new URLSearchParams();
    if (record.chapterId) query.set("chapter", record.chapterId);
    if (record.chapterProgress !== undefined) query.set("position", String(record.chapterProgress));
    return { ...base, kind: "book", id: `book:${record.datasetId}:${record.itemKey}`,
      datasetId: record.datasetId, itemKey: record.itemKey, chapterProgress: record.chapterProgress,
      href: `/book/${encodeURIComponent(record.datasetId)}/${encodeURIComponent(record.itemKey)}${query.size ? `?${query}` : ""}` };
  }
  return { ...base, kind: "periodical", id: `periodical:${record.publication}:${record.issueId}`,
    publicationId: record.publication, totalPages: record.totalPages,
    href: `/archive/${record.publication}/${record.issueId}#page-${record.currentPage}` };
}

export function startWebReadingHistorySync() {
  const sync = startReadingHistorySync({
    account: () => useAccountSessionStore.getState(),
    subscribeAccount: (changed) => useAccountSessionStore.subscribe(changed),
    subscribe: (changed) => useRecentReadingStore.subscribe(changed),
    read: () => {
      const state = useRecentReadingStore.getState();
      return { ownerId: state.historyOwnerId, accounts: state.historyAccounts,
        clearedAt: state.historyClearedAt, records: state.items.flatMap((item) => recentItemToRecord(item) ?? []) };
    },
    write: (state) => useRecentReadingStore.setState({ historyOwnerId: state.ownerId,
      historyAccounts: state.accounts, historyClearedAt: state.clearedAt, items: state.records.map(readingRecordToRecentItem) }),
    exchange: async (userId, data, signal) => {
      const { authClient } = await import("../account/auth");
      // The RPC ships with the accompanying migration.
      const { data: remote, error } = await (authClient as any).rpc("sync_reading_history", {
        p_user_id: userId, p_records: data.records, p_cleared_at: data.clearedAt,
      }).abortSignal(signal);
      if (error) throw error;
      return remote as ReadingHistoryData;
    },
  });
  const refresh = () => sync.refresh();
  window.addEventListener("online", refresh);
  window.addEventListener("focus", refresh);
  const visibility = () => { if (document.visibilityState === "visible") refresh(); };
  document.addEventListener("visibilitychange", visibility);
  return () => {
    sync.stop();
    window.removeEventListener("online", refresh);
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", visibility);
  };
}
