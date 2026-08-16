import { create } from "zustand";

interface PlatformAccountState {
  initialized: boolean;
  userId: string | null;
  displayName: string | null;
}

export const platformAccountConfigured = Boolean(
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
);

export const usePlatformAccountStore = create<PlatformAccountState>(() => ({
  initialized: !platformAccountConfigured,
  userId: null,
  displayName: null,
}));

export function startPlatformAccountSync(): () => void {
  if (!platformAccountConfigured) {
    usePlatformAccountStore.setState({ initialized: true, userId: null, displayName: null });
    return () => {};
  }

  let active = true;
  let stopAuthSync = () => {};
  let unsubscribe = () => {};

  void import("../account/auth").then(({ startAuthSync, useAuthStore }) => {
    if (!active) return;
    const update = () => {
      const { initialized, user, profile } = useAuthStore.getState();
      usePlatformAccountStore.setState({
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
