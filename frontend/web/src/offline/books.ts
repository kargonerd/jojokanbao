import { OfflineBookLibrary, type OfflineBookRecord } from "@jojo/content";
import { create } from "zustand";
import { useAccountSessionStore } from "../account/session";
import { browserOfflineBookRepository } from "./repository";
import { supportsOfflineBooks } from "./platform";
import { browserOfflineBookIdentity } from "./identity";

export const offlineBooks = new OfflineBookLibrary({
  repository: browserOfflineBookRepository,
  baseUrl: import.meta.env.VITE_CONTENT_CDN_BASE || "https://blacknews.jojokanbao.cn/",
  identity: browserOfflineBookIdentity,
  downloadIdentity: () => useAccountSessionStore.getState(),
  canDownload: () => supportsOfflineBooks() && Boolean(navigator.locks),
  lock: async (datasetId, task, ifAvailable = false) => {
    if (!navigator.locks) { if (!ifAvailable) await task(); return; }
    await navigator.locks.request(`jojo-offline-books:${datasetId}`, { mode: "exclusive", ifAvailable }, async (lock) => { if (lock) await task(); });
  },
  digest: async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer))].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
});

interface OfflineState { identityVersion: number; books: OfflineBookRecord[]; loading: boolean; error: string }
export const useOfflineBooksStore = create<OfflineState>(() => ({ identityVersion: 0, books: [], loading: true, error: "" }));
let initialized: Promise<void> | undefined;
let refreshVersion = 0;
async function refresh() {
  const version = ++refreshVersion;
  try {
    const books = await offlineBooks.list();
    if (version === refreshVersion) useOfflineBooksStore.setState({ books, loading: false, error: "" });
  } catch (reason) {
    if (version === refreshVersion) useOfflineBooksStore.setState({ loading: false, error: reason instanceof Error ? reason.message : "无法读取离线书籍" });
  }
}

/** Starts once for the application lifetime, including account changes outside the reader. */
export function startOfflineAccountSync(): void {
  if (!supportsOfflineBooks() || initialized) return;
  const channel = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel("jojo-offline-books-v1");
  channel?.addEventListener("message", () => { void refresh(); });
  offlineBooks.subscribe(() => { void refresh(); channel?.postMessage("changed"); });
  let previousIdentity = browserOfflineBookIdentity();
  const syncIdentity = () => {
    const current = browserOfflineBookIdentity();
    if (current.userId !== previousIdentity.userId || current.initialized !== previousIdentity.initialized) {
      previousIdentity = current;
      useOfflineBooksStore.setState((state) => ({ books: [], loading: true, identityVersion: state.identityVersion + 1 }));
      void offlineBooks.identityChanged().then(refresh).catch(() => { void refresh(); });
    }
  };
  useAccountSessionStore.subscribe(syncIdentity);
  window.addEventListener("storage", (event) => { if (!event.key || event.key === "jojo-auth-session") syncIdentity(); });
  window.addEventListener("offline", syncIdentity);
  // Reconnection itself is not a sign-out: let the auth client resolve its session.
  initialized = offlineBooks.recover().then(() => offlineBooks.identityChanged()).then(refresh)
    .catch(() => { void refresh(); });
}

export async function openOfflineBook(datasetId: string, itemKey: string) {
  if (!supportsOfflineBooks() || !globalThis.indexedDB) return undefined;
  startOfflineAccountSync();
  await initialized;
  return offlineBooks.open(datasetId, itemKey);
}

export async function requestOfflinePersistence(): Promise<void> {
  if (!supportsOfflineBooks()) throw new Error("请在客户端书架中下载书籍");
  // Browser storage can still be cleared by the user; persistence protects against automatic eviction where supported.
  try { await navigator.storage?.persist?.(); } catch { /* Download remains available when permission is not granted. */ }
}
