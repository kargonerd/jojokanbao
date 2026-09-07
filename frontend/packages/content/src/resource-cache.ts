/** Only public CDN content belongs here, never account data or API responses. */
export interface ResourceCacheEntry { bytes: Uint8Array; expiresAt: number }
export interface ResourceCacheStore {
  get(key: string): Promise<ResourceCacheEntry | undefined>;
  set(key: string, entry: ResourceCacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
}

export const CONTENT_CACHE_BYTES = 64 * 1024 * 1024;
export const CONTENT_CACHE_ENTRIES = 384;

/** A bounded session cache also coalesces reading, cover loading and prefetch. */
export class ResourceCache {
  private entries = new Map<string, ResourceCacheEntry>();
  private pending = new Map<string, Promise<Uint8Array>>();
  private bytes = 0;

  constructor(private store?: ResourceCacheStore, private maxBytes = 16 * 1024 * 1024) {}

  async delete(key: string) {
    const entry = this.entries.get(key);
    if (entry) { this.bytes -= entry.bytes.length; this.entries.delete(key); }
    await this.store?.delete(key).catch(() => undefined);
  }

  get(key: string, ttl: number, load: () => Promise<Uint8Array>): Promise<Uint8Array> {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.bytes -= cached.bytes.length;
      if (cached.expiresAt > Date.now()) {
        this.remember(key, cached);
        return Promise.resolve(cached.bytes);
      }
    }
    const pending = this.pending.get(key);
    if (pending) return pending;
    const task = (async () => {
      const stored = await this.store?.get(key).catch(() => undefined);
      const entry = stored && stored.expiresAt > Date.now()
        ? stored : { bytes: await load(), expiresAt: Date.now() + ttl };
      this.remember(key, entry);
      // Cache writes must not delay rendering or break reading when storage is full.
      if (entry !== stored) void this.store?.set(key, entry).catch(() => undefined);
      return entry.bytes;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }

  private remember(key: string, entry: ResourceCacheEntry) {
    if (entry.bytes.length > this.maxBytes) return;
    this.entries.set(key, entry);
    this.bytes += entry.bytes.length;
    while (this.bytes > this.maxBytes || this.entries.size > 128) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes.length;
      this.entries.delete(oldest);
    }
  }
}

/** Aborting one subscriber must not cancel another subscriber's shared fetch. */
export function abortable<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("读取已取消"));
    if (signal.aborted) { task.catch(() => undefined); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
