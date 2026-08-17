import { create } from "zustand";
import { platformAccountConfigured, usePlatformAccountStore } from "./platform/accountSession";

export const FEATURE_FLAG_KEYS = [
  "library.bookshelf",
  "reader.annotations",
  "rag.workspace",
  "olds.workspace",
] as const;

export type FeatureFlagKey = typeof FEATURE_FLAG_KEYS[number];
type FeatureFlagValues = Record<FeatureFlagKey, boolean>;

const disabledFlags = (): FeatureFlagValues => Object.fromEntries(
  FEATURE_FLAG_KEYS.map((key) => [key, false]),
) as FeatureFlagValues;

function migrationCompatibilityFlags(): FeatureFlagValues {
  const flags = disabledFlags();
  if (usePlatformAccountStore.getState().userId) {
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

export async function refreshFeatureFlags(): Promise<void> {
  const sequence = ++refreshSequence;
  useFeatureFlagStore.setState({ initialized: false });
  if (!platformAccountConfigured) {
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

export function useFeatureFlag(key: FeatureFlagKey): boolean {
  return useFeatureFlagStore((state) => state.flags[key]);
}
