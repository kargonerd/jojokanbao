import { FLAG_REFRESH_INTERVAL_MS, type FlagSession } from "./flags";

/** Start from SDK disk cache; validate before publishing any new remote payload. */
export function startConfigSync<T>(options: {
  open(): Promise<FlagSession<unknown>>;
  parse(value: unknown): T | undefined;
  publish(value: T): void;
  foreground(): boolean;
  cache: { read(): Promise<unknown>; write(value: T): Promise<void> };
}) {
  let stopped = false;
  let opening = false;
  let session: FlagSession<unknown> | undefined;
  let unsubscribe: (() => void) | undefined;
  let refreshedAt: number | undefined;
  let writes = Promise.resolve();
  const publish = (payload: unknown) => {
    const value = options.parse(payload);
    if (!stopped && value !== undefined) {
      options.publish(value);
      writes = writes.then(() => options.cache.write(value)).catch(() => undefined);
    }
  };
  const refresh = async () => {
    if (stopped || opening || !options.foreground()) return;
    if (refreshedAt !== undefined && Date.now() - refreshedAt < 30_000) return;
    refreshedAt = Date.now();
    if (!session) {
      opening = true;
      try {
        try {
          const cached = options.parse(await options.cache.read());
          if (!stopped && cached !== undefined) options.publish(cached);
        } catch { /* Storage may be unavailable. */ }
        if (stopped) return;
        const opened = await options.open();
        if (stopped) { opened.dispose(); return; }
        session = opened;
        publish(session.cached());
        unsubscribe = session.subscribe(publish);
      } catch { return; }
      finally { opening = false; }
    }
    try { session.refresh(); } catch { /* Retain the last validated value. */ }
  };
  void refresh();
  const timer = setInterval(() => { void refresh(); }, FLAG_REFRESH_INTERVAL_MS);
  return {
    refresh: () => { void refresh(); },
    stop: () => { stopped = true; clearInterval(timer); unsubscribe?.(); session?.dispose(); },
  };
}
