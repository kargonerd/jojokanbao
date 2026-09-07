import { transformJoxBytes, type JojoFragment } from "@jojo/content";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedMobileBookItem } from "./books";

vi.mock("./contentCache", () => ({ mobileContentCache: () => undefined }));
const loaded = {
  manifestObject: "content/books/test/manifest.jox",
  manifest: { itemId: "book", content: { chapters: ["c1", "c2", "c3"].map((id) => ({ id, title: id, object: `${id}.jox`, sha256: id })) },
    assets: [{ id: "cover", object: "cover.jox", mediaType: "image/png", sha256: "cover-v1" }] },
} as unknown as LoadedMobileBookItem;

async function fragmentResponse(key: string, id: string, assets: string[] = []) {
  const fragment: JojoFragment = { formatVersion: "jojo-fragment/1", itemId: "book", fragmentId: id, type: "chapter", title: id,
    order: 1, body: { format: "text", value: `正文 ${id}` }, assetRefs: assets, annotations: [] };
  const compressed = new Uint8Array(await new Response(new Blob([JSON.stringify(fragment)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
  return new Response(transformJoxBytes(compressed, key).slice().buffer);
}

beforeEach(() => vi.resetModules());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("native book loading and prefetch", () => {
  it("prefetches both neighbours including pictures and reuses them on demand", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const key = new URL(String(input)).pathname.slice(1);
      if (key.endsWith("cover.jox")) return new Response(transformJoxBytes(new Uint8Array([1, 2]), key).slice().buffer);
      return fragmentResponse(key, key.split("/").at(-1)!.replace(".jox", ""), ["cover"]);
    });
    vi.stubGlobal("fetch", fetcher);
    const { loadMobileBookChapter, prefetchMobileBookChapters } = await import("./books");
    await prefetchMobileBookChapters(loaded, "c2", new AbortController().signal);
    const fetched = fetcher.mock.calls.length;
    expect(fetched).toBe(3); // next + previous + one shared image
    const chapter = await loadMobileBookChapter(loaded, "c3");
    expect(chapter.fragment.fragmentId).toBe("c3");
    expect(chapter.assetUrls.cover).toContain("data:image/png;base64,");
    expect(fetcher).toHaveBeenCalledTimes(fetched);
    const cancelled = new AbortController(); cancelled.abort();
    await prefetchMobileBookChapters(loaded, "c1", cancelled.signal);
    expect(fetcher).toHaveBeenCalledTimes(fetched);
  });

  it("a stalled picture cannot trap the chapter in loading forever; a later request retries it", async () => {
    const chapterBytes = await fragmentResponse("content/books/test/c1.jox", "c1", ["cover"]);
    let pictureFails = true;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const key = new URL(String(input)).pathname.slice(1);
      if (key.endsWith("c1.jox")) return chapterBytes.clone();
      if (pictureFails) return new Promise<Response>(() => undefined);
      return new Response(transformJoxBytes(new Uint8Array([1]), key).slice().buffer);
    });
    vi.stubGlobal("fetch", fetcher);
    const { loadMobileBookChapter } = await import("./books");
    vi.useFakeTimers();
    const task = loadMobileBookChapter(loaded, "c1");
    // Let the real gzip body reader finish before advancing the asset deadline.
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(20_001);
    expect((await task).fragment.fragmentId).toBe("c1");
    pictureFails = false;
    expect((await loadMobileBookChapter(loaded, "c1")).assetUrls.cover).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
