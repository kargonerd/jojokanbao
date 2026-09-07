import { CONTENT_CACHE_BYTES, CONTENT_CACHE_ENTRIES, type ResourceCacheStore } from "@jojo/content";

// expo-file-system is already bundled by Expo in the 0.0.3 native runtimes.
// Keep it lazy: cache availability must never be a prerequisite for reading.
export function mobileContentCache(): ResourceCacheStore {
  return store ??= createStore();
}

let store: ResourceCacheStore | undefined;
function createStore(): ResourceCacheStore {
  let writes = Promise.resolve();
  async function location(key: string) {
    const Crypto = await import("expo-crypto");
    const { File, Directory, Paths } = await import("expo-file-system");
    const directory = new Directory(Paths.cache, "jojo-public-content-v1");
    directory.create({ idempotent: true, intermediates: true });
    const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, key);
    return { directory, file: new File(directory, hash) };
  }
  return {
    async delete(key) {
      await writes.catch(() => undefined);
      const { file } = await location(key);
      if (file.exists) file.delete();
    },
    async get(key) {
      const { file } = await location(key);
      if (!file.exists) return undefined;
      const data = await file.bytes();
      if (data.length < 8) { file.delete(); return undefined; }
      const expiresAt = new DataView(data.buffer, data.byteOffset, data.byteLength).getFloat64(0);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) { file.delete(); return undefined; }
      return { bytes: data.slice(8), expiresAt };
    },
    set(key, entry) {
      if (entry.bytes.length + 8 > CONTENT_CACHE_BYTES) return Promise.resolve();
      writes = writes.catch(() => undefined).then(async () => {
        const { directory, file } = await location(key);
        const data = new Uint8Array(entry.bytes.length + 8);
        new DataView(data.buffer).setFloat64(0, entry.expiresAt);
        data.set(entry.bytes, 8);
        file.write(data);
        // File metadata getters cross into native synchronous I/O. Snapshot once
        // per file, rather than reading modificationTime on every sort comparison.
        const files = directory.list().filter((value) => "size" in value && "bytes" in value)
          .map((cached) => ({ file: cached, size: cached.size ?? 0, modified: cached.modificationTime ?? 0 }))
          .sort((a, b) => b.modified - a.modified);
        let total = 0;
        for (const [index, cached] of files.entries()) {
          total += cached.size;
          if (index >= CONTENT_CACHE_ENTRIES || total > CONTENT_CACHE_BYTES) cached.file.delete();
        }
      });
      return writes;
    },
  };
}
