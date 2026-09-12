import { create } from "zustand";
import { accountSessionConfigured, useAccountSessionStore } from "./account/session";
import { disabledFlags, FeatureFlagRuntime, FLAG_REFRESH_INTERVAL_MS, FEATURE_FLAG_KEYS, type FeatureFlagKey, type FeatureFlagValues } from "@jojo/analytics/flags";

export { FEATURE_FLAG_KEYS, type FeatureFlagKey };

function migrationCompatibilityFlags(): FeatureFlagValues {
  const flags = disabledFlags();
  if (useAccountSessionStore.getState().userId) {
    flags["library.bookshelf"] = true;
    flags["reader.annotations"] = true;
  }
  return flags;
}

function featureRpcIsMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown };
  return value.code === "PGRST202"
    || (typeof value.message === "string" && value.message.includes("get_my_feature_flags"));
}
const VISITOR_STORAGE_KEY = "jojo-feature-visitor-id";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function featureVisitorId(): string | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(VISITOR_STORAGE_KEY);
  if (stored && UUID_PATTERN.test(stored)) return stored;
  if (typeof globalThis.crypto?.randomUUID !== "function") return null;
  const created = globalThis.crypto.randomUUID();
  window.localStorage.setItem(VISITOR_STORAGE_KEY, created);
  return created;
}

interface FeatureFlagState {
  initialized: boolean;
  revision: string;
  flags: FeatureFlagValues;
}

export const useFeatureFlagStore = create<FeatureFlagState>(() => ({
  initialized: false,
  revision: "",
  flags: disabledFlags(),
}));

let refreshSequence = 0;
const postHogFlags = new FeatureFlagRuntime(async (userId) => {
  const { openBrowserFlagSession } = await import("@jojo/analytics/browser-flags");
  return openBrowserFlagSession({ userId, token: import.meta.env.VITE_POSTHOG_TOKEN, host: import.meta.env.VITE_POSTHOG_HOST });
}, (flags) => useFeatureFlagStore.setState({ initialized: true, revision: "posthog", flags }));

const usesPostHog = () => import.meta.env.VITE_FEATURE_FLAG_PROVIDER === "posthog";

export function startFeatureFlagSync(): () => void {
  const refresh = () => {
    if (useAccountSessionStore.getState().initialized) void refreshFeatureFlags();
  };
  const stopAuth = useAccountSessionStore.subscribe((state, previous) => {
    if (state.initialized !== previous.initialized || state.userId !== previous.userId) refresh();
  });
  const foreground = () => { if (document.visibilityState === "visible") refresh(); };
  window.addEventListener("focus", foreground);
  document.addEventListener("visibilitychange", foreground);
  window.addEventListener("online", refresh);
  const interval = window.setInterval(foreground, FLAG_REFRESH_INTERVAL_MS);
  refresh();
  return () => {
    stopAuth();
    window.removeEventListener("focus", foreground);
    document.removeEventListener("visibilitychange", foreground);
    window.removeEventListener("online", refresh);
    window.clearInterval(interval);
    refreshSequence++;
    postHogFlags.stop();
  };
}

export async function refreshFeatureFlags(): Promise<void> {
  const sequence = ++refreshSequence;
  if (usesPostHog()) {
    await postHogFlags.setUser(accountSessionConfigured ? useAccountSessionStore.getState().userId : null);
    return;
  }
  useFeatureFlagStore.setState({ initialized: false });
  if (!accountSessionConfigured) {
    useFeatureFlagStore.setState({ initialized: true, revision: "local-unconfigured", flags: disabledFlags() });
    return;
  }
  try {
    const { authClient } = await import("./account/auth");
    const { data, error } = await (authClient as any).rpc("get_my_feature_flags", {
      p_keys: [...FEATURE_FLAG_KEYS],
      p_visitor_id: featureVisitorId(),
    });
    if (error) throw error;
    if (sequence !== refreshSequence) return;
    const flags = disabledFlags();
    const revisions: string[] = [];
    for (const row of Array.isArray(data) ? data : []) {
      if (!row || !FEATURE_FLAG_KEYS.includes(row.flag_key as FeatureFlagKey)) continue;
      flags[row.flag_key as FeatureFlagKey] = row.enabled === true;
      revisions.push(`${row.flag_key}:${row.revision}`);
    }
    useFeatureFlagStore.setState({ initialized: true, revision: revisions.join("|"), flags });
  } catch (error) {
    if (sequence !== refreshSequence) return;
    const migrationPending = featureRpcIsMissing(error);
    useFeatureFlagStore.setState({
      initialized: true,
      revision: migrationPending ? "migration-pending" : "unavailable",
      flags: migrationPending ? migrationCompatibilityFlags() : disabledFlags(),
    });
  }
}

export function isFeatureEnabled(key: FeatureFlagKey, flags = useFeatureFlagStore.getState().flags): boolean {
  // Local voice previews must not change the remotely controlled release flag.
  const speechPreview = import.meta.env.DEV && import.meta.env.MODE === "development" && key === "reader.speech";
  return speechPreview || flags[key];
}

export function useFeatureFlag(key: FeatureFlagKey): boolean {
  return useFeatureFlagStore((state) => isFeatureEnabled(key, state.flags));
}
