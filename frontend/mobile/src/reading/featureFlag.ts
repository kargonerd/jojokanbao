import { AppState } from "react-native";
import { create } from "zustand";
import { mobileAuthClient, useMobileAuthStore } from "../account/auth";
import { disabledFlags, FeatureFlagRuntime, FLAG_REFRESH_INTERVAL_MS, type FeatureFlagKey, type FeatureFlagValues } from "@jojo/analytics/flags";
import { mobileUsesPostHogFlags, openMobileFlagSession } from "./posthogFlags";

export const useSpeechFlagStore = create<{ userId: string | null; enabled: boolean }>(() => ({ userId: null, enabled: false }));
export const useMobileFeatureFlagStore = create<{ userId: string | null; flags: FeatureFlagValues }>(() => ({ userId: null, flags: disabledFlags() }));

export function useMobileFeatureFlag(key: FeatureFlagKey): boolean {
  const userId = useMobileAuthStore((state) => state.user?.id);
  const enabled = useMobileFeatureFlagStore((state) => Boolean(userId && state.userId === userId && state.flags[key]));
  const speech = useSpeechFlagStore((state) => Boolean(userId && state.userId === userId && state.enabled));
  // Before cutover only speech had a native UI gate. Keep existing offline features available.
  return mobileUsesPostHogFlags() ? enabled : key === "reader.speech" ? speech : true;
}

export function mobileSpeechAllowed(): boolean {
  const userId = useMobileAuthStore.getState().user?.id;
  const flag = useSpeechFlagStore.getState();
  return Boolean(userId && flag.userId === userId && flag.enabled);
}

/** Same remote flag as Web/Desktop. Never reuse a previous account's decision. */
export function startSpeechFlagSync(): () => void {
  if (mobileUsesPostHogFlags()) return startPostHogSpeechSync();
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

function startPostHogSpeechSync(): () => void {
  const runtime = new FeatureFlagRuntime(openMobileFlagSession, (flags) => {
    useMobileFeatureFlagStore.setState({ userId: useMobileAuthStore.getState().user?.id ?? null, flags });
    useSpeechFlagStore.setState({ userId: useMobileAuthStore.getState().user?.id ?? null, enabled: flags["reader.speech"] });
  });
  const refresh = () => {
    const { initialized, user } = useMobileAuthStore.getState();
    if (initialized) void runtime.setUser(user?.id ?? null);
  };
  const stopAuth = useMobileAuthStore.subscribe((state, previous) => {
    if (state.initialized !== previous.initialized || state.user?.id !== previous.user?.id) refresh();
  });
  const appState = AppState.addEventListener("change", (state) => { if (state === "active") refresh(); });
  const interval = setInterval(() => { if (AppState.currentState === "active") refresh(); }, FLAG_REFRESH_INTERVAL_MS);
  refresh();
  return () => { stopAuth(); appState.remove(); clearInterval(interval); runtime.stop(); useSpeechFlagStore.setState({ userId: null, enabled: false }); };
}
