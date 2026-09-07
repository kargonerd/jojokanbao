import { describe, expect, it, vi } from "vitest";
import { mobileContentCache } from "./contentCache";
import { CONTENT_CACHE_BYTES } from "@jojo/content";

const files = vi.hoisted(() => new Map<string, { bytes: Uint8Array; modified: number; size?: number }>());
const metadataReads = vi.hoisted(() => ({ modified: 0, size: 0 }));
vi.mock("expo-crypto", () => ({ CryptoDigestAlgorithm: { SHA256: "sha256" }, digestStringAsync: async (_: string, key: string) => key.replaceAll(/\W/g, "-") }));
vi.mock("expo-file-system", () => {
  class File {
    uri: string;
    constructor(directory: Directory, key: string) { this.uri = `${directory.uri}/${key}`; }
    get exists() { return files.has(this.uri); }
    get size() { metadataReads.size++; return files.get(this.uri)?.size ?? files.get(this.uri)?.bytes.length ?? 0; }
    get modificationTime() { metadataReads.modified++; return files.get(this.uri)?.modified ?? 0; }
    bytes = async () => files.get(this.uri)!.bytes;
    write(bytes: Uint8Array) { files.set(this.uri, { bytes, modified: Date.now() }); }
    delete() { files.delete(this.uri); }
  }
  class Directory {
    uri: string;
    constructor(base: string, name: string) { this.uri = `${base}/${name}`; }
    create() {}
    list() { return [...files.keys()].filter((key) => key.startsWith(`${this.uri}/`)).map((key) => new File(this, key.slice(this.uri.length + 1))); }
  }
  return { File, Directory, Paths: { cache: "cache" } };
});

describe("native public content disk cache", () => {
  it("reads native metadata only once per file while sorting a populated cache", async () => {
    files.clear();
    for (let index = 0; index < 80; index++) {
      files.set(`cache/jojo-public-content-v1/item-${index}`, {
        bytes: new Uint8Array([index]), modified: (index * 37) % 80,
      });
    }
    metadataReads.modified = 0; metadataReads.size = 0;
    await mobileContentCache().set("new", { bytes: new Uint8Array([1]), expiresAt: Date.now() + 10000 });
    expect(files.size).toBe(81);
    expect(metadataReads).toEqual({ modified: 81, size: 81 });
  });

  it("reads across consumers, removes expired files, and evicts only its own oversized cache", async () => {
    files.clear();
    const store = mobileContentCache();
    const expiresAt = Date.now() + 10000;
    await store.set("cover", { bytes: new Uint8Array([1, 2]), expiresAt });
    expect(await mobileContentCache().get("cover")).toEqual({ bytes: new Uint8Array([1, 2]), expiresAt });
    await store.set("stale", { bytes: new Uint8Array([3]), expiresAt: Date.now() - 1 });
    expect(await store.get("stale")).toBeUndefined();
    files.set("cache/jojo-public-content-v1/old", { bytes: new Uint8Array(), modified: 1, size: CONTENT_CACHE_BYTES });
    files.set("cache/something-else/user-file", { bytes: new Uint8Array([9]), modified: 1 });
    await store.set("latest", { bytes: new Uint8Array([4]), expiresAt });
    expect(files.has("cache/jojo-public-content-v1/old")).toBe(false);
    expect(files.has("cache/something-else/user-file")).toBe(true);
    await store.delete("cover");
    expect(await store.get("cover")).toBeUndefined();
  });
});
