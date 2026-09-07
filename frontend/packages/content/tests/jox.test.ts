import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JoxClient,
  ResourceCache,
  gunzipJoxJson,
  resolveJoxObject,
  transformJoxBytes,
} from "../src";

afterEach(() => vi.useRealTimers());

describe("Jox transport", () => {
  it("times out stalled response bodies and retries instead of caching a pending promise forever", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => ({ ok: true, arrayBuffer: () => new Promise<ArrayBuffer>(() => undefined) }) as Response);
    const client = new JoxClient("https://cdn.example", fetcher, new ResourceCache());
    const pending = expect(client.fetchBytes("chapter.jox")).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(20_001); await pending;
    fetcher.mockResolvedValueOnce(new Response(new Uint8Array([1, 2])));
    expect(await client.fetchBytes("chapter.jox")).toEqual(new Uint8Array([1, 2]));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("separates content revisions and evicts invalid cached JSON", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => new Response(new Uint8Array([1, 2])));
    const client = new JoxClient("https://cdn.example", fetcher, new ResourceCache());
    await client.fetchBytes("cover.jox", undefined, "default", "v1");
    await client.fetchBytes("cover.jox", undefined, "default", "v1");
    await client.fetchBytes("cover.jox", undefined, "default", "v2");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("v=v2");
    await expect(client.fetchJson("broken.jox")).rejects.toBeDefined();
    await expect(client.fetchJson("broken.jox")).rejects.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("round-trips arbitrary bytes and supports offsets", () => {
    const original = Uint8Array.from({ length: 1024 }, (_, index) => index % 251);
    const encoded = transformJoxBytes(original, "content/books/assets/example.jox");
    expect(encoded).not.toEqual(original);
    expect(transformJoxBytes(encoded, "content/books/assets/example.jox"))
      .toEqual(original);
    expect(transformJoxBytes(encoded.slice(117, 488), "content/books/assets/example.jox", 117))
      .toEqual(original.slice(117, 488));
  });

  it("decodes gzip JSON and fetches objects relative to the configured root", async () => {
    const payload = { formatVersion: "jojo-catalog/1", revision: 1 };
    const compressed = new Uint8Array(await new Response(
      new Blob([JSON.stringify(payload)]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer());
    const key = "catalog.jox";
    const protectedBytes = transformJoxBytes(compressed, key);
    await expect(gunzipJoxJson(protectedBytes, key)).resolves.toEqual(payload);

    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://cdn.example/root/catalog.jox");
      expect(init?.cache).toBe("no-store");
      return new Response(protectedBytes.slice().buffer);
    };
    const client = new JoxClient("https://cdn.example/root", fetchFn as typeof fetch);
    await expect(client.fetchJson(key, undefined, "no-store")).resolves.toEqual(payload);
  });

  it("resolves nested object references", () => {
    expect(resolveJoxObject(
      "content/books/example/items/full-book/manifest.jox",
      "chapters/abc.jox",
    )).toBe("content/books/example/items/full-book/chapters/abc.jox");
    expect(resolveJoxObject(
      "content/newspapers/rmrb/availability/1990.jox",
      "../items/1990/01/1990-01-01/manifest.jox",
    )).toBe("content/newspapers/rmrb/items/1990/01/1990-01-01/manifest.jox");
  });
});
