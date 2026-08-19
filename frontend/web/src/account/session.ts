import { create } from "zustand";

interface AccountSessionState {
  initialized: boolean;
  userId: string | null;
  displayName: string | null;
}

export const accountSessionConfigured = Boolean(
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
);

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

  void import("../account/auth").then(({ startAuthSync, useAuthStore }) => {
    if (!active) return;
    const update = () => {
      const { initialized, user, profile } = useAuthStore.getState();
      useAccountSessionStore.setState({
        initialized,
        userId: user?.id || null,
        displayName: profile?.display_name?.trim() || null,
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
  const { useAuthStore } = await import("../account/auth");
  await useAuthStore.getState().signOut();
}
