import { gzipSync } from "node:zlib";
import { transformJoxBytes, type ResourceCacheEntry } from "@jojo/content";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const entries = vi.hoisted(() => new Map<string, ResourceCacheEntry>());
vi.mock("./contentCache", () => ({ mobileContentCache: () => ({
  get: async (key: string) => entries.get(key),
  set: async (key: string, entry: ResourceCacheEntry) => { entries.set(key, entry); },
  delete: async (key: string) => { entries.delete(key); },
}) }));

const objects: Record<string, unknown> = {
  "catalog.jox": { formatVersion: "jojo-catalog/1", datasets: [
    { datasetId: "book", type: "book", title: "测试书", indexObject: "books/test/index.jox" },
  ] },
  "books/test/index.jox": { formatVersion: "jojo-delivery-index/1", datasetId: "book", items: [
    { itemId: "book:full", itemKey: "full", title: "测试书", order: 1, manifestObject: "manifest.jox" },
  ] },
  "books/test/manifest.jox": { formatVersion: "jojo-item-manifest/1", datasetId: "book", itemId: "book:full",
    content: { chapters: [{ id: "c1", title: "第一章", object: "c1.jox", sha256: "chapter-v1" }] },
    assets: [{ id: "cover", type: "image", role: "cover", object: "cover.jox", sha256: "cover-v1", mediaType: "image/png" }],
  },
  "books/test/c1.jox": { formatVersion: "jojo-fragment/1", itemId: "book:full", fragmentId: "c1", type: "chapter",
    title: "第一章", order: 1, body: { format: "text", value: "已缓存的正文" }, assetRefs: ["cover"], annotations: [],
  },
};
const onlineFetch = async (input: RequestInfo | URL) => {
  const key = new URL(String(input)).pathname.slice(1);
  const bytes = key.endsWith("cover.jox") ? new Uint8Array([1, 2, 3]) : gzipSync(JSON.stringify(objects[key]));
  return new Response(transformJoxBytes(bytes, key).slice().buffer);
};

beforeEach(() => { entries.clear(); vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("book offline reading", () => {
  it("reopens the complete cached path after restart and expiry, including catalog, cover and chapter", async () => {
    vi.stubGlobal("fetch", onlineFetch);
    const online = await import("./books");
    const first = await online.loadMobileBookItem("book", "full");
    await online.loadMobileBookChapter(first, "c1");
    await online.loadMobileBookCover(first.book, "full");
    expect(entries.size).toBe(7);

    // Discard all in-memory promises, as an offline cold start would.
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 8 * 86400_000);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Network request failed")));
    const offline = await import("./books");
    const books = await offline.loadMobileBooks();
    expect(books[0]?.title).toBe("测试书");
    expect(await offline.resolveMobileBookOpenTarget(books[0]!)).toMatchObject({ screen: "BookReader", itemKey: "full" });
    const restored = await offline.loadMobileBookItem("book", "full");
    const chapter = await offline.loadMobileBookChapter(restored, "c1");
    expect(chapter.fragment.body.value).toBe("已缓存的正文");
    expect(chapter.assetUrls.cover).toBe("data:image/png;base64,AQID");
    expect(await offline.loadMobileBookCover(restored.book, "full")).toBe("data:image/png;base64,AQID");
    expect(entries.size).toBe(7);
  });

  it("restores recent and bookshelf covers by ID even when the entire catalog chain is missing", async () => {
    vi.stubGlobal("fetch", onlineFetch);
    const online = await import("./books");
    await online.loadMobileBookCover("book", "full");
    for (const key of entries.keys()) if (!key.startsWith("jojo:book-cover:")) entries.delete(key);
    vi.resetModules();
    const offlineFetch = vi.fn().mockRejectedValue(new TypeError("Network request failed"));
    vi.stubGlobal("fetch", offlineFetch);
    const offline = await import("./books");
    expect(await offline.loadMobileBookCover("book", "full")).toBe("data:image/png;base64,AQID");
    expect(await offline.loadMobileBookCover("book", "book:full")).toBe("data:image/png;base64,AQID");
    expect(offlineFetch).not.toHaveBeenCalled();
  });

  it("retries a catalog that failed offline without restarting the app", async () => {
    const fetcher = vi.fn(onlineFetch).mockRejectedValueOnce(new TypeError("Network request failed"));
    vi.stubGlobal("fetch", fetcher);
    const books = await import("./books");
    await expect(books.loadMobileBooks()).rejects.toThrow("Network request failed");
    expect((await books.loadMobileBookItem("book", "full")).volume.itemKey).toBe("full");
  });
});
