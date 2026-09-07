import { afterEach, describe, expect, it, vi } from "vitest";
import { browserContentCache, CONTENT_CACHE_BYTES, CONTENT_CACHE_ENTRIES } from "../src";

afterEach(() => vi.unstubAllGlobals());
describe("browser persistent CDN cache", () => {
  it("survives a new cache consumer, expires stale files and bounds total bytes", async () => {
    const entries = new Map<string, Response>();
    const key = (request: string | Request) => typeof request === "string" ? request : request.url;
    vi.stubGlobal("caches", { open: async () => ({
      match: async (request: string | Request) => entries.get(key(request))?.clone(),
      put: async (request: string | Request, response: Response) => { entries.set(key(request), response); },
      delete: async (request: string | Request) => entries.delete(key(request)),
      keys: async () => [...entries.keys()].map((url) => new Request(url)),
    }) });
    const expiresAt = Date.now() + 100000;
    for (const id of ["old", "recent"]) entries.set(`https://cdn.test/${id}`, new Response(null, { headers: {
      "content-length": String(CONTENT_CACHE_BYTES / 2), "x-jojo-expires": String(expiresAt),
    } }));
    const store = browserContentCache();
    await store.set("https://cdn.test/cover", { bytes: new Uint8Array([1, 2]), expiresAt });
    expect(entries.has("https://cdn.test/old")).toBe(false);
    expect((await browserContentCache().get("https://cdn.test/cover"))?.bytes).toEqual(new Uint8Array([1, 2]));
    await store.set("https://cdn.test/stale", { bytes: new Uint8Array([3]), expiresAt: Date.now() - 1 });
    expect(await store.get("https://cdn.test/stale")).toBeUndefined();
    for (let i = 0; i < CONTENT_CACHE_ENTRIES; i++) entries.set(`https://cdn.test/small-${i}`, new Response(null, { headers: {
      "content-length": "1", "x-jojo-expires": String(expiresAt),
    } }));
    await store.set("https://cdn.test/new", { bytes: new Uint8Array([9]), expiresAt });
    expect(entries.size).toBe(CONTENT_CACHE_ENTRIES);
    expect(entries.has("https://cdn.test/new")).toBe(true);
    await store.delete("https://cdn.test/new");
    expect(await store.get("https://cdn.test/new")).toBeUndefined();
  });
});
