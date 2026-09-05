import { AppState } from "react-native";
import { create } from "zustand";
import { mobileAuthClient, useMobileAuthStore } from "../account/auth";

export const useSpeechFlagStore = create<{ userId: string | null; enabled: boolean }>(() => ({ userId: null, enabled: false }));

export function mobileSpeechAllowed(): boolean {
  const userId = useMobileAuthStore.getState().user?.id;
  const flag = useSpeechFlagStore.getState();
  return Boolean(userId && flag.userId === userId && flag.enabled);
}

/** Same remote flag as Web/Desktop. Never reuse a previous account's decision. */
export function startSpeechFlagSync(): () => void {
  let sequence = 0;
  const refresh = async () => {
    const request = ++sequence;
    const userId = useMobileAuthStore.getState().user?.id ?? null;
    if (useSpeechFlagStore.getState().userId !== userId) useSpeechFlagStore.setState({ userId, enabled: false });
    if (!userId) return;
    try {
      const { data, error } = await mobileAuthClient.rpc("get_my_feature_flags", { p_keys: ["reader.speech"], p_visitor_id: null });
      if (request !== sequence) return;
      const rows = data as Array<{ flag_key: string; enabled: boolean }> | null;
      useSpeechFlagStore.setState({ userId, enabled: !error && Array.isArray(rows) && rows.some((row) => row.flag_key === "reader.speech" && row.enabled === true) });
    } catch { if (request === sequence) useSpeechFlagStore.setState({ userId, enabled: false }); }
  };
  void refresh();
  const stopAuth = useMobileAuthStore.subscribe((state, previous) => { if (state.user?.id !== previous.user?.id) void refresh(); });
  const appState = AppState.addEventListener("change", (state) => { if (state === "active") void refresh(); });
  return () => { sequence++; stopAuth(); appState.remove(); useSpeechFlagStore.setState({ userId: null, enabled: false }); };
}
