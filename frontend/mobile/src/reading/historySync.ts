import { AppState } from "react-native";
import { startReadingHistorySync, type ReadingHistoryData } from "@jojo/content";
import { mobileAuthClient, useMobileAuthStore } from "../account/auth";
import { useMobileStore } from "../store/mobileStore";

export function startMobileReadingHistorySync() {
  let stop = () => {};
  let active = true;
  const start = () => {
    if (!active) return;
    stop();
    const sync = startReadingHistorySync({
      account: () => { const { initialized, user } = useMobileAuthStore.getState(); return { initialized, userId: user?.id ?? null }; },
      subscribeAccount: (changed) => useMobileAuthStore.subscribe(changed),
      subscribe: (changed) => useMobileStore.subscribe(changed),
      read: () => {
        const s = useMobileStore.getState();
        return { ownerId: s.historyOwnerId, clearedAt: s.historyClearedAt, accounts: s.historyAccounts,
          records: [...s.recentBooks.map(({ spreadIndex: _spread, scrollProgress: _scroll, ...book }) => ({ ...book, kind: "book" as const })),
            ...s.recentIssues.map((issue) => ({ ...issue, kind: "periodical" as const }))] };
      },
      write: (s) => {
        const local = useMobileStore.getState();
        useMobileStore.setState({ historyOwnerId: s.ownerId, historyClearedAt: s.clearedAt, historyAccounts: s.accounts,
          recentBooks: s.records.flatMap((r) => {
            if (r.kind !== "book") return [];
            const old = local.historyOwnerId === undefined || local.historyOwnerId === s.ownerId || local.historyOwnerId === null
              ? local.recentBooks.find((b) => b.datasetId === r.datasetId && b.itemKey === r.itemKey && b.updatedAt === r.updatedAt) : undefined;
            return [{ ...r, ...(old ? { spreadIndex: old.spreadIndex, scrollProgress: old.scrollProgress } : {}) }];
          }),
          recentIssues: s.records.flatMap((r) => r.kind === "periodical" ? [r] : []),
        });
      },
      exchange: async (userId, data, signal) => {
        const { data: remote, error } = await (mobileAuthClient as any).rpc("sync_reading_history", {
          p_user_id: userId, p_records: data.records, p_cleared_at: data.clearedAt,
        }).abortSignal(signal);
        if (error) throw error;
        return remote as ReadingHistoryData;
      },
    });
    const subscription = AppState.addEventListener("change", (state) => { if (state === "active") sync.refresh(); });
    stop = () => { subscription.remove(); sync.stop(); };
  };
  const hydrated = useMobileStore.persist.onFinishHydration(start);
  if (useMobileStore.persist.hasHydrated()) start();
  return () => { active = false; hydrated(); stop(); };
}
