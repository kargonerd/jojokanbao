import { beforeEach, describe, expect, it, vi } from "vitest";
import { MOBILE_CONTENT_CACHE_BYTES } from "./contentCache";

let mobileContentCache: typeof import("./contentCache").mobileContentCache;
beforeEach(async () => { vi.resetModules(); ({ mobileContentCache } = await import("./contentCache")); });

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
  return { File, Directory, Paths: { cache: "cache", document: "document" } };
});

describe("native public content disk cache", () => {
  it("reads native metadata only once per file while sorting a populated cache", async () => {
    files.clear();
    for (let index = 0; index < 80; index++) {
      files.set(`document/jojo-public-content-v1/item-${index}`, {
        bytes: new Uint8Array([index]), modified: (index * 37) % 80,
      });
    }
    metadataReads.modified = 0; metadataReads.size = 0;
    await mobileContentCache().set("new", { bytes: new Uint8Array([1]), expiresAt: Date.now() + 10000 });
    expect(files.size).toBe(81);
    expect(metadataReads).toEqual({ modified: 81, size: 81 });
    await mobileContentCache().set("next", { bytes: new Uint8Array([2]), expiresAt: Date.now() + 10000 });
    expect(metadataReads).toEqual({ modified: 81, size: 81 });
  });

  it("preserves expired data across consumers and evicts only its own oversized cache", async () => {
    files.clear();
    const store = mobileContentCache();
    const expiresAt = Date.now() + 10000;
    await store.set("cover", { bytes: new Uint8Array([1, 2]), expiresAt });
    expect(await mobileContentCache().get("cover")).toEqual({ bytes: new Uint8Array([1, 2]), expiresAt });
    const stale = { bytes: new Uint8Array([3]), expiresAt: Date.now() - 1 };
    await store.set("stale", stale);
    expect(await store.get("stale")).toEqual(stale);
    files.set("document/jojo-public-content-v1/old", { bytes: new Uint8Array(), modified: 1, size: MOBILE_CONTENT_CACHE_BYTES });
    files.set("cache/something-else/user-file", { bytes: new Uint8Array([9]), modified: 1 });
    vi.resetModules();
    await (await import("./contentCache")).mobileContentCache().set("latest", { bytes: new Uint8Array([4]), expiresAt });
    expect(files.has("document/jojo-public-content-v1/old")).toBe(false);
    expect(files.has("cache/something-else/user-file")).toBe(true);
    await store.delete("cover");
    expect(await store.get("cover")).toBeUndefined();
  });

  it("retains more than 64 MiB and 384 files, prioritizing cover snapshots over newer chapter data", async () => {
    files.clear();
    for (let index = 0; index < 500; index++) files.set(`document/jojo-public-content-v1/chapter-${index}`, {
      bytes: new Uint8Array(), modified: 2, size: 160 * 1024,
    });
    await mobileContentCache().set("jojo:book-cover:book:full", { bytes: new Uint8Array([1]), expiresAt: 1 });
    expect(files.size).toBe(501);
    const cover = [...files.keys()].find((key) => key.includes("/p-"))!;
    files.get(cover)!.modified = 1;
    files.set("document/jojo-public-content-v1/large-chapter", { bytes: new Uint8Array(), modified: 3, size: 60 * 1024 * 1024 });
    vi.resetModules();
    await (await import("./contentCache")).mobileContentCache().set("latest", { bytes: new Uint8Array([2]), expiresAt: 1 });
    expect(files.has(cover)).toBe(true);
    expect([...files.values()].reduce((total, file) => total + (file.size ?? file.bytes.length), 0)).toBeLessThanOrEqual(MOBILE_CONTENT_CACHE_BYTES);
  });

  it("migrates a readable old cache entry into durable storage without losing expired data", async () => {
    files.clear();
    const data = new Uint8Array(9); new DataView(data.buffer).setFloat64(0, 1); data[8] = 7;
    files.set("cache/jojo-public-content-v1/legacy", { bytes: data, modified: 1 });
    expect(await mobileContentCache().get("legacy")).toEqual({ bytes: new Uint8Array([7]), expiresAt: 1 });
    await vi.waitFor(() => expect(files.has("document/jojo-public-content-v1/legacy")).toBe(true));
    expect(files.has("cache/jojo-public-content-v1/legacy")).toBe(false);
    expect(await mobileContentCache().get("legacy")).toEqual({ bytes: new Uint8Array([7]), expiresAt: 1 });
  });

  it("discards truncated or invalid cache files", async () => {
    files.clear();
    files.set("cache/jojo-public-content-v1/broken", { bytes: new Uint8Array([1]), modified: 1 });
    expect(await mobileContentCache().get("broken")).toBeUndefined();
    const bytes = new Uint8Array(9);
    new DataView(bytes.buffer).setFloat64(0, NaN);
    files.set("cache/jojo-public-content-v1/broken", { bytes, modified: 1 });
    expect(await mobileContentCache().get("broken")).toBeUndefined();
    expect(files.size).toBe(0);
  });
});
