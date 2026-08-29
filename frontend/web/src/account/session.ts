import { create } from "zustand";
import { clearCachedDisplayName, readCachedDisplayName, writeCachedDisplayName } from "./profileCache";

interface AccountSessionState {
  initialized: boolean;
  userId: string | null;
  displayName: string | null;
}

export const accountSessionConfigured = Boolean(
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
);

// Begin fetching the authentication chunk as soon as the application shell is
// evaluated, while the public page continues rendering in parallel.
const authModule = accountSessionConfigured ? import("./auth") : undefined;

export const useAccountSessionStore = create<AccountSessionState>(() => ({
  initialized: !accountSessionConfigured,
  userId: null,
  displayName: null,
}));

export function startAccountSessionSync(): () => void {
  if (!accountSessionConfigured) {
    useAccountSessionStore.setState({ initialized: true, userId: null, displayName: null });
    return () => {};
  }

  let active = true;
  let stopAuthSync = () => {};
  let unsubscribe = () => {};

  void authModule!.then(({ startAuthSync, useAuthStore }) => {
    if (!active) return;
    const update = () => {
      const { initialized, user, profile } = useAuthStore.getState();
      const userId = user?.id || null;
      const freshDisplayName = profile?.display_name?.trim() || null;
      if (userId && freshDisplayName) writeCachedDisplayName(userId, freshDisplayName);
      else if (initialized && !userId) clearCachedDisplayName();
      useAccountSessionStore.setState({
        initialized,
        userId,
        displayName: freshDisplayName || (userId ? readCachedDisplayName(userId) : null),
      });
    };
    unsubscribe = useAuthStore.subscribe(update);
    stopAuthSync = startAuthSync();
    update();
  });

  return () => {
    active = false;
    unsubscribe();
    stopAuthSync();
  };
}

export async function signOutAccount(): Promise<void> {
  const { useAuthStore } = await (authModule ?? import("./auth"));
  await useAuthStore.getState().signOut();
}
