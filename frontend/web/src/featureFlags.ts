import { create } from "zustand";
import { platformAccountConfigured } from "./platform/accountSession";

export const FEATURE_FLAG_KEYS = [
  "library.bookshelf",
  "reader.annotations",
  "agent.chat",
  "rag.workspace",
  "olds.workspace",
] as const;

export type FeatureFlagKey = typeof FEATURE_FLAG_KEYS[number];
type FeatureFlagValues = Record<FeatureFlagKey, boolean>;

const disabledFlags = (): FeatureFlagValues => Object.fromEntries(
  FEATURE_FLAG_KEYS.map((key) => [key, false]),
) as FeatureFlagValues;
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
  } catch {
    if (sequence !== refreshSequence) return;
    useFeatureFlagStore.setState({ initialized: true, revision: "unavailable", flags: disabledFlags() });
  }
}

export function useFeatureFlag(key: FeatureFlagKey): boolean {
  return useFeatureFlagStore((state) => state.flags[key]);
}
