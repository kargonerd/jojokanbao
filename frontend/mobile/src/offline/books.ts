import { JoxClient, OfflineBookLibrary, offlineIdentityFromStoredSession, type OfflineBookRecord, type OfflineBookIdentity } from "@jojo/content";
import { create } from "zustand";
import { MOBILE_ACCOUNT_CONFIGURED, mobileAuthClient, useMobileAuthStore } from "../account/auth";
import { mobileOfflineBookRepository } from "./repository";

const CONTENT_CDN = process.env.EXPO_PUBLIC_CONTENT_CDN_BASE?.trim() || "https://blacknews.jojokanbao.cn/";
let persistedOwner: string | null = null;
let identityRevision = 0;
const authenticatedIdentity = (): OfflineBookIdentity => {
  const state = useMobileAuthStore.getState();
  return { initialized: state.initialized || !MOBILE_ACCOUNT_CONFIGURED, userId: state.user?.id ?? null };
};
const identity = (): OfflineBookIdentity => {
  const current = authenticatedIdentity();
  return current.userId || !persistedOwner ? current : { initialized: true, userId: persistedOwner };
};
async function hydrateLocalIdentity() {
  const revision = identityRevision;
  try {
    const { default: AsyncStorage } = await import("@react-native-async-storage/async-storage");
    const local = offlineIdentityFromStoredSession({ initialized: false, userId: null }, await AsyncStorage.getItem("jojo-mobile-auth-session"), true);
    if (revision === identityRevision) persistedOwner = local.userId;
  } catch { if (revision === identityRevision) persistedOwner = null; }
}
export function mobileBookOwnerId(offline = false): string | null { return (offline ? identity() : authenticatedIdentity()).userId; }
export function assertMobileBookOwner(ownerId: string | undefined, offline: boolean) {
  if (!ownerId || mobileBookOwnerId(offline) !== ownerId) throw new Error("登录状态已改变，请重新打开书籍");
}

export const mobileOfflineBooks = new OfflineBookLibrary({
  repository: mobileOfflineBookRepository,
  baseUrl: CONTENT_CDN,
  identity,
  downloadIdentity: authenticatedIdentity,
  digest: async (bytes) => {
    const Crypto = await import("expo-crypto");
    return [...new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes.slice().buffer))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  },
});

export const useMobileOfflineBooksStore = create<{ identityVersion: number; books: OfflineBookRecord[]; loading: boolean; error: string }>(() => ({ identityVersion: 0, books: [], loading: true, error: "" }));
let initialized: Promise<void> | undefined;
let version = 0;
async function refresh() {
  const current = ++version;
  try {
    const books = await mobileOfflineBooks.list();
    if (current === version) useMobileOfflineBooksStore.setState({ books, loading: false, error: "" });
  } catch (reason) {
    if (current === version) useMobileOfflineBooksStore.setState({ loading: false, error: reason instanceof Error ? reason.message : "无法读取离线书籍" });
  }
}

export function startMobileOfflineAccountSync(): void {
  if (initialized) return;
  mobileOfflineBooks.subscribe(() => { void refresh(); });
  useMobileAuthStore.subscribe((current, previous) => {
    if (current.user?.id !== previous.user?.id || current.initialized !== previous.initialized) {
      identityRevision += 1;
      if (previous.user?.id && !current.user?.id) persistedOwner = null;
      useMobileOfflineBooksStore.setState((state) => ({ books: [], loading: true, identityVersion: state.identityVersion + 1 }));
      void hydrateLocalIdentity().then(() => mobileOfflineBooks.identityChanged()).then(refresh).catch(() => { void refresh(); });
    }
  });
  mobileAuthClient.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      identityRevision += 1;
      persistedOwner = null;
      useMobileOfflineBooksStore.setState((state) => ({ books: [], loading: true, identityVersion: state.identityVersion + 1 }));
      void mobileOfflineBooks.identityChanged().then(refresh).catch(() => { void refresh(); });
    }
  });
  initialized = hydrateLocalIdentity().then(() => mobileOfflineBooks.recover()).then(() => mobileOfflineBooks.identityChanged()).then(refresh).catch(() => { void refresh(); });
}

export async function openMobileOfflineBook(datasetId: string, itemKey: string) {
  startMobileOfflineAccountSync();
  await initialized;
  await hydrateLocalIdentity();
  return mobileOfflineBooks.open(datasetId, itemKey);
}

export function mobileAuthenticatedBookClient(): JoxClient {
  const owner = authenticatedIdentity().userId;
  if (!owner) throw new Error("请先登录，再阅读这本书");
  return new JoxClient(CONTENT_CDN, async (input, init) => {
    if (authenticatedIdentity().userId !== owner) throw new Error("登录状态已改变，请重新打开书籍");
    const response = await fetch(input, { ...init, cache: "no-store" });
    if (authenticatedIdentity().userId !== owner) throw new Error("登录状态已改变，请重新打开书籍");
    return response;
  });
}
