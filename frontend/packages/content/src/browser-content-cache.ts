import { CONTENT_CACHE_BYTES, CONTENT_CACHE_ENTRIES, type ResourceCacheStore } from "./resource-cache";

/** CacheStorage survives page reloads; unavailable/private storage falls back to HTTP. */
export function browserContentCache(): ResourceCacheStore {
  return store ??= createStore();
}

let store: ResourceCacheStore | undefined;
function createStore(): ResourceCacheStore {
  const open = () => globalThis.caches.open("jojo-public-content-v1");
  let writes = Promise.resolve();
  return {
    async delete(key) { await writes.catch(() => undefined); await (await open()).delete(key); },
    async get(key) {
      const cache = await open();
      const response = await cache.match(key);
      if (!response) return undefined;
      const expiresAt = Number(response.headers.get("x-jojo-expires"));
      if (!expiresAt || expiresAt <= Date.now()) { await cache.delete(key); return undefined; }
      return { bytes: new Uint8Array(await response.arrayBuffer()), expiresAt };
    },
    set(key, entry) {
      if (entry.bytes.length > CONTENT_CACHE_BYTES) return Promise.resolve();
      writes = writes.catch(() => undefined).then(async () => {
        const cache = await open();
        // Delete + put puts refreshed entries at the end of the eviction order.
        await cache.delete(key);
        await cache.put(key, new Response(entry.bytes.slice().buffer, { headers: {
          "x-jojo-expires": String(entry.expiresAt), "content-length": String(entry.bytes.length),
        } }));
        const keys = await cache.keys();
        let total = 0;
        let count = 0;
        for (const request of [...keys].reverse()) {
          const response = await cache.match(request);
          const length = Number(response?.headers.get("content-length") ?? 0);
          const expired = Number(response?.headers.get("x-jojo-expires") ?? 0) <= Date.now();
          if (expired || count >= CONTENT_CACHE_ENTRIES || total + length > CONTENT_CACHE_BYTES) await cache.delete(request);
          else { total += length; count++; }
        }
      });
      return writes;
    },
  };
}
