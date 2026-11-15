import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ReadingHistoryData } from "@jojo/content";

export type RecentReadingKind = "book" | "periodical";

export interface RecentReadingItem {
  datasetId?: string;
  id: string;
  itemKey?: string;
  kind: RecentReadingKind;
  publicationId?: string;
  title: string;
  subtitle: string;
  href: string;
  progress: number;
  updatedAt: number;
  chapterProgress?: number;
  totalPages?: number;
}

interface RecentReadingState {
  items: RecentReadingItem[];
  historyOwnerId?: string | null;
  historyClearedAt: number;
  historyAccounts: Record<string, ReadingHistoryData>;
  remember: (item: Omit<RecentReadingItem, "updatedAt">) => void;
}

export const useRecentReadingStore = create<RecentReadingState>()(
  persist(
    (set) => ({
      items: [],
      historyClearedAt: 0,
      historyAccounts: {},
      remember: (item) => set((state) => ({
        items: [
          { ...item, progress: Math.max(0, Math.min(100, item.progress)), updatedAt: Date.now() },
          ...state.items.filter((candidate) => candidate.id !== item.id),
        ].slice(0, 16),
      })),
    }),
    { name: "jojo-recent-reading" },
  ),
);

function recordHref(item: RecentReadingItem): URL | undefined {
  try { return new URL(item.href, "https://jojokanbao.cn"); } catch { return undefined; }
}

/** The chapter and in-chapter position to reopen a book at, when one was recorded. */
export function recentBookResume(items: RecentReadingItem[], datasetId: string, itemKey: string) {
  const item = items.find((candidate) => candidate.kind === "book"
    && candidate.datasetId === datasetId && candidate.itemKey === itemKey);
  if (!item) return undefined;
  const url = recordHref(item);
  const chapterId = url?.searchParams.get("chapter");
  if (!url || !chapterId) return undefined;
  // Older records kept the chapter but not the position; start that chapter.
  const saved = item.chapterProgress
    ?? (url.searchParams.has("position") ? Number(url.searchParams.get("position")) : 0);
  return Number.isFinite(saved)
    ? { chapterId, position: Math.max(0, Math.min(1, saved)) }
    : undefined;
}

/** The last page read in one issue, from the deep link kept in the record. */
export function recentIssuePage(items: RecentReadingItem[], publication: string, issueId: string) {
  const item = items.find((candidate) => {
    if (candidate.kind !== "periodical" || candidate.publicationId !== publication) return false;
    const parts = recordHref(candidate)?.pathname.split("/").filter(Boolean) ?? [];
    return (parts[0] === "archive" || parts[0] === "reader") && parts[2] === issueId;
  });
  const page = item ? /#page-(\d+)$/i.exec(item.href)?.[1] : undefined;
  return page ? Number(page) : undefined;
}
