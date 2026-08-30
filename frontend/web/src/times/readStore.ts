import { create } from "zustand";

const LOCAL_STORAGE_KEY = "jojo-times-read-articles-v1";
const MAX_VIEWED_ARTICLES = 500;

interface TimesReadState {
  readById: Record<string, boolean>;
}

export const useTimesReadStore = create<TimesReadState>(() => ({
  readById: {},
}));

function localReadIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(LOCAL_STORAGE_KEY) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && Boolean(value))
      : [];
  } catch {
    return [];
  }
}

function writeLocalReadIds(ids: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(ids.slice(-MAX_VIEWED_ARTICLES)));
  } catch {
    // Private browsing or a full storage quota must not block reading.
  }
}

export function hydrateTimesReadState(articleIds: string[]): void {
  const viewed = new Set(localReadIds());
  const uniqueIds = [...new Set(articleIds.filter(Boolean))];
  useTimesReadStore.setState((current) => ({
    readById: {
      ...current.readById,
      ...Object.fromEntries(uniqueIds.map((id) => [id, viewed.has(id)])),
    },
  }));
}

export function markTimesArticleRead(articleId: string): void {
  if (!articleId) return;
  const viewed = localReadIds().filter((id) => id !== articleId);
  viewed.push(articleId);
  writeLocalReadIds(viewed);
  useTimesReadStore.setState((current) => ({
    readById: { ...current.readById, [articleId]: true },
  }));
}
