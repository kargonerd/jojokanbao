/** Product rollout only. Authentication, ownership and quotas are enforced by the server. */
export const FEATURE_FLAG_KEYS = ["library.bookshelf", "reader.annotations", "reader.speech"] as const;
export type FeatureFlagKey = typeof FEATURE_FLAG_KEYS[number];
export type FeatureFlagValues = Record<FeatureFlagKey, boolean>;
// PostHog keys cannot contain dots; keep existing application/database keys stable.
export const POSTHOG_FLAG_KEYS = {
  "library.bookshelf": "library_bookshelf",
  "reader.annotations": "reader_annotations",
  "reader.speech": "reader_speech",
} as const satisfies Record<FeatureFlagKey, string>;
export const disabledFlags = (): FeatureFlagValues => ({
  "library.bookshelf": false, "reader.annotations": false, "reader.speech": false,
});
export function flagValues(values?: Record<string, unknown>): FeatureFlagValues {
  return Object.fromEntries(FEATURE_FLAG_KEYS.map((key) => [key, values?.[POSTHOG_FLAG_KEYS[key]] === true])) as FeatureFlagValues;
}

// Let the SDK persist decisions; the application only holds a view of the active account.
export interface FlagSession<T = FeatureFlagValues> {
  cached(): T;
  subscribe(listener: (flags: T) => void): () => void;
  refresh(): void;
  dispose(): void;
}

export class FeatureFlagRuntime {
  private userId: string | null | undefined;
  private generation = 0;
  private session?: FlagSession;
  private unsubscribe?: () => void;
  private lastRefresh = 0;
  private opening = false;
  constructor(
    private open: (userId: string) => Promise<FlagSession>,
    private publish: (flags: FeatureFlagValues) => void,
  ) {}

  async setUser(userId: string | null): Promise<void> {
    if (this.userId === userId && this.opening) return;
    if (this.userId === userId && this.session) { this.refresh(); return; }
    const generation = ++this.generation;
    this.userId = userId;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session?.dispose();
    this.session = undefined;
    this.opening = false;
    this.publish(disabledFlags());
    if (!userId) return;
    this.opening = true;
    try {
      const session = await this.open(userId);
      if (generation !== this.generation) { session.dispose(); return; }
      this.session = session;
      this.publish(session.cached());
      this.unsubscribe = session.subscribe((flags) => {
        if (generation === this.generation) this.publish(flags);
      });
      this.lastRefresh = 0;
      this.refresh(true);
    } catch { /* Defaults remain usable if storage or SDK loading fails. A later refresh retries. */ }
    finally { if (generation === this.generation) this.opening = false; }
  }

  refresh(force = false): void {
    if (!this.session) {
      if (this.userId) void this.setUser(this.userId);
      return;
    }
    // Focus/visibility commonly arrive together. Do not spend a request on every event.
    if (!force && Date.now() - this.lastRefresh < 30_000) return;
    this.lastRefresh = Date.now();
    try { this.session.refresh(); } catch { /* Retain the last usable snapshot. */ }
  }

  stop(): void {
    this.generation++;
    this.unsubscribe?.();
    this.session?.dispose();
    this.unsubscribe = undefined;
    this.session = undefined;
    this.userId = undefined;
    this.opening = false;
    this.publish(disabledFlags());
  }
}

export const FLAG_REFRESH_INTERVAL_MS = 5 * 60_000;
export function flagStorageNamespace(token: string, host: string, userId: string): string {
  return `jojo.flags.v1.${encodeURIComponent(`${host}:${token}:${userId}`)}`;
}
