import { create } from "zustand";
import {
  loadTimesArticleReads,
  markTimesArticleRead as persistTimesArticleRead,
  markTimesArticleUnread as persistTimesArticleUnread,
} from "./readApi";

const LOCAL_STORAGE_KEY = "jojo-times-read-articles-v1";

interface TimesReadState {
  ownerKey: string;
  readById: Record<string, boolean>;
  loadedById: Record<string, boolean>;
  error: string;
}

export const useTimesReadStore = create<TimesReadState>(() => ({
  ownerKey: "",
  readById: {},
  loadedById: {},
  error: "",
}));

let requestRevision = 0;

function ownerKey(userId: string | null): string {
  return userId ? `user:${userId}` : "guest";
}

function activateOwner(userId: string | null): string {
  const nextOwner = ownerKey(userId);
  if (useTimesReadStore.getState().ownerKey !== nextOwner) {
    requestRevision += 1;
    useTimesReadStore.setState({
      ownerKey: nextOwner,
      readById: {},
      loadedById: {},
      error: "",
    });
  }
  return nextOwner;
}

function localReadIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LOCAL_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function writeLocalReadIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify([...ids].slice(-5_000)));
  } catch {
    // Private browsing or a full storage quota must not block reading.
  }
}

export async function hydrateTimesReadState(articleIds: string[], userId: string | null): Promise<void> {
  const activeOwner = activateOwner(userId);
  const uniqueIds = [...new Set(articleIds.filter(Boolean))];
  const state = useTimesReadStore.getState();
  const missing = uniqueIds.filter((id) => !state.loadedById[id]);
  if (!missing.length) return;

  if (!userId) {
    const local = localReadIds();
    useTimesReadStore.setState((current) => current.ownerKey !== activeOwner ? current : ({
      readById: { ...current.readById, ...Object.fromEntries(missing.map((id) => [id, local.has(id)])) },
      loadedById: { ...current.loadedById, ...Object.fromEntries(missing.map((id) => [id, true])) },
      error: "",
    }));
    return;
  }

  const revision = requestRevision;
  try {
    const batches = Array.from(
      { length: Math.ceil(missing.length / 500) },
      (_, index) => missing.slice(index * 500, (index + 1) * 500),
    );
    const rows = (await Promise.all(batches.map((batch) => loadTimesArticleReads(batch)))).flat();
    if (revision !== requestRevision || useTimesReadStore.getState().ownerKey !== activeOwner) return;
    const readIds = new Set(rows.map((row) => row.articleId));
    useTimesReadStore.setState((current) => {
      // A detail open or explicit toggle can finish while this lookup is in
      // flight. Those mutations mark the article as loaded, so never replace
      // them with an older server snapshot.
      const unresolved = missing.filter((id) => !current.loadedById[id]);
      return {
        readById: { ...current.readById, ...Object.fromEntries(unresolved.map((id) => [id, readIds.has(id)])) },
        loadedById: { ...current.loadedById, ...Object.fromEntries(unresolved.map((id) => [id, true])) },
        error: "",
      };
    });
  } catch (reason) {
    if (revision !== requestRevision) return;
    useTimesReadStore.setState({ error: reason instanceof Error ? reason.message : String(reason) });
  }
}

async function setReadState(articleId: string, issueDate: string, read: boolean, userId: string | null): Promise<void> {
  const activeOwner = activateOwner(userId);
  const previous = Boolean(useTimesReadStore.getState().readById[articleId]);
  useTimesReadStore.setState((current) => ({
    readById: { ...current.readById, [articleId]: read },
    loadedById: { ...current.loadedById, [articleId]: true },
    error: "",
  }));

  if (!userId) {
    const local = localReadIds();
    if (read) local.add(articleId);
    else local.delete(articleId);
    writeLocalReadIds(local);
    return;
  }

  try {
    if (read) await persistTimesArticleRead(articleId, issueDate);
    else await persistTimesArticleUnread(articleId);
  } catch (reason) {
    if (useTimesReadStore.getState().ownerKey !== activeOwner) return;
    useTimesReadStore.setState((current) => ({
      readById: { ...current.readById, [articleId]: previous },
      error: reason instanceof Error ? reason.message : String(reason),
    }));
    throw reason;
  }
}

export function markTimesArticleRead(articleId: string, issueDate: string, userId: string | null): Promise<void> {
  return setReadState(articleId, issueDate, true, userId);
}

export function markTimesArticleUnread(articleId: string, issueDate: string, userId: string | null): Promise<void> {
  return setReadState(articleId, issueDate, false, userId);
}
