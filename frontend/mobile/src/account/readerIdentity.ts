import type { JojoAuthStore } from "@jojo/auth";
import { create } from "zustand";

const CACHE_KEY = "jojo-mobile-reader-name";
interface ReaderIdentity { userId: string | null; displayName: string | null }
interface Storage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
}

function normalizeName(value: unknown): string | null {
  const name = typeof value === "string" ? value.trim() : "";
  return name && name.length <= 50 ? name : null;
}

/** Cache only the display label, scoped to the restored authenticated user. */
export function createReaderIdentityCache(auth: JojoAuthStore, storage: Storage) {
  const useIdentityStore = create<ReaderIdentity>(() => ({ userId: null, displayName: null }));
  let writes = Promise.resolve();
  const persist = (write: () => Promise<void>) => {
    writes = writes.then(write).catch(() => undefined);
  };

  const start = () => {
    let active = true;
    let currentUserId: string | null | undefined;
    let revision = 0;
    const update = () => {
      const { user, profile, initialized } = auth.getState();
      if (!initialized) return;
      const userId = user?.id ?? null;
      const name = profile?.id === userId ? normalizeName(profile?.display_name) : null;
      if (userId !== currentUserId) {
        const previousUserId = currentUserId;
        currentUserId = userId;
        const readRevision = ++revision;
        useIdentityStore.setState({ userId, displayName: null });
        if (userId) {
          void storage.getItem(CACHE_KEY).then((value) => {
            if (!active || readRevision !== revision || auth.getState().user?.id !== userId || !value) return;
            const cached = JSON.parse(value) as ReaderIdentity | null;
            if (cached?.userId !== userId || useIdentityStore.getState().displayName) return;
            useIdentityStore.setState({ displayName: normalizeName(cached.displayName) });
          }).catch(() => undefined);
        } else if (previousUserId) {
          persist(() => storage.removeItem(CACHE_KEY));
        }
      }
      if (name && useIdentityStore.getState().displayName !== name) {
        useIdentityStore.setState({ userId, displayName: name });
        persist(() => storage.setItem(CACHE_KEY, JSON.stringify({ userId, displayName: name })));
      }
    };
    const stop = auth.subscribe(update);
    update();
    return () => { active = false; stop(); };
  };

  return { useIdentityStore, start };
}
