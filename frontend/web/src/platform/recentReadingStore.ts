import { create } from "zustand";
import { persist } from "zustand/middleware";

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
}

interface RecentReadingState {
  items: RecentReadingItem[];
  remember: (item: Omit<RecentReadingItem, "updatedAt">) => void;
}

export const useRecentReadingStore = create<RecentReadingState>()(
  persist(
    (set) => ({
      items: [],
      remember: (item) => set((state) => ({
        items: [
          { ...item, progress: Math.max(0, Math.min(100, item.progress)), updatedAt: Date.now() },
          ...state.items.filter((candidate) => candidate.id !== item.id),
        ].slice(0, 8),
      })),
    }),
    { name: "jojo-recent-reading" },
  ),
);
