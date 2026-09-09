import type { ResourceCacheStore } from "@jojo/content";

export const MOBILE_CONTENT_CACHE_BYTES = 128 * 1024 * 1024;
export const MOBILE_CONTENT_CACHE_ENTRIES = 4096;

// expo-file-system is already bundled by Expo in the 0.0.3 native runtimes.
// Keep it lazy: cache availability must never be a prerequisite for reading.
export function mobileContentCache(): ResourceCacheStore {
  return store ??= createStore();
}

let store: ResourceCacheStore | undefined;
function createStore(): ResourceCacheStore {
  let writes = Promise.resolve();
  type CachedFile = { file: { uri: string; delete(): void }; size: number; modified: number; priority: number };
  let inventory: Map<string, CachedFile> | undefined;
  async function location(key: string) {
    const Crypto = await import("expo-crypto");
    const { File, Directory, Paths } = await import("expo-file-system");
    const directory = new Directory(Paths.document, "jojo-public-content-v1");
    directory.create({ idempotent: true, intermediates: true });
    const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, key);
    const priority = key.startsWith("jojo:book-cover:") || key.startsWith("jojo:times-feed:")
      || /\/(catalog|index|manifest)\.jox(?:\?|$)/.test(key);
    return { directory, file: new File(directory, `${priority ? "p-" : ""}${hash}`),
      legacy: new File(new Directory(Paths.cache, "jojo-public-content-v1"), hash) };
  }
  const api: ResourceCacheStore = {
    async delete(key) {
      await writes.catch(() => undefined);
      const { file, legacy } = await location(key);
      if (file.exists) file.delete();
      inventory?.delete(file.uri);
      if (legacy.exists) legacy.delete();
    },
    async get(key) {
      const { file, legacy } = await location(key);
      const source = file.exists ? file : legacy;
      if (!source.exists) { inventory?.delete(file.uri); return undefined; }
      const data = await source.bytes();
      if (data.length < 8) { source.delete(); inventory?.delete(source.uri); return undefined; }
      const expiresAt = new DataView(data.buffer, data.byteOffset, data.byteLength).getFloat64(0);
      // Expiry requests revalidation; it must not erase the only offline copy.
      if (!Number.isFinite(expiresAt)) { source.delete(); inventory?.delete(source.uri); return undefined; }
      const entry = { bytes: data.slice(8), expiresAt };
      if (source === legacy) void api.set(key, entry).then(() => {
        if (file.exists && legacy.exists) legacy.delete();
      }).catch(() => undefined);
      return entry;
    },
    set(key, entry) {
      if (entry.bytes.length + 8 > MOBILE_CONTENT_CACHE_BYTES) return Promise.resolve();
      writes = writes.catch(() => undefined).then(async () => {
        const { directory, file } = await location(key);
        const data = new Uint8Array(entry.bytes.length + 8);
        new DataView(data.buffer).setFloat64(0, entry.expiresAt);
        data.set(entry.bytes, 8);
        file.write(data);
        // Scan native metadata once per runtime. At 4096 entries, repeating
        // thousands of synchronous native getters on every write stalls the UI.
        inventory ??= new Map(directory.list().filter((value) => "size" in value && "bytes" in value)
          .map((cached) => [cached.uri, { file: cached, size: cached.size ?? 0, modified: cached.modificationTime ?? 0,
            priority: cached.uri.split("/").at(-1)?.startsWith("p-") ? 1 : 0 }]));
        inventory.set(file.uri, { file, size: data.length, modified: Date.now(),
          priority: file.uri.split("/").at(-1)?.startsWith("p-") ? 1 : 0 });
        const files = [...inventory.values()]
          .sort((a, b) => b.priority - a.priority || b.modified - a.modified);
        let total = 0;
        for (const [index, cached] of files.entries()) {
          total += cached.size;
          if (index >= MOBILE_CONTENT_CACHE_ENTRIES || total > MOBILE_CONTENT_CACHE_BYTES) {
            cached.file.delete(); inventory.delete(cached.file.uri);
          }
        }
      });
      return writes;
    },
  };
  return api;
}
