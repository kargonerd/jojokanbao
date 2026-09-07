import { afterEach, describe, expect, it, vi } from "vitest";
import { abortable, ResourceCache, type ResourceCacheEntry, type ResourceCacheStore } from "../src";

afterEach(() => vi.useRealTimers());
const bytes = (value: number) => new Uint8Array([value]);
describe("bounded public content cache", () => {
  it("coalesces prefetch and demand, then reuses completed bytes", async () => {
    const cache = new ResourceCache();
    let finish!: (value: Uint8Array) => void;
    const load = vi.fn(() => new Promise<Uint8Array>((resolve) => { finish = resolve; }));
    const first = cache.get("chapter", 1000, load);
    const second = cache.get("chapter", 1000, load);
    await Promise.resolve(); finish(bytes(1));
    expect(await first).toEqual(await second);
    expect(await cache.get("chapter", 1000, load)).toEqual(bytes(1));
    expect(load).toHaveBeenCalledOnce();
  });

  it("uses persistent data across sessions but never after expiry", async () => {
    vi.useFakeTimers();
    const entries = new Map<string, ResourceCacheEntry>();
    const store: ResourceCacheStore = { get: async (key) => entries.get(key), set: async (key, entry) => { entries.set(key, entry); }, delete: async (key) => { entries.delete(key); } };
    const load = vi.fn(async () => bytes(2));
    await new ResourceCache(store).get("cover", 100, load);
    await new ResourceCache(store).get("cover", 100, load);
    expect(load).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(101);
    await new ResourceCache(store).get("cover", 100, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("evicts least recently used bytes and does not retain failures", async () => {
    const cache = new ResourceCache(undefined, 2);
    const load = vi.fn(async () => bytes(3));
    await cache.get("a", 1000, load); await cache.get("b", 1000, load);
    await cache.get("a", 1000, load); await cache.get("c", 1000, load);
    await cache.get("b", 1000, load);
    expect(load).toHaveBeenCalledTimes(4);
    await expect(cache.get("fail", 1000, async () => { throw Error("offline"); })).rejects.toThrow("offline");
    expect(await cache.get("fail", 1000, load)).toEqual(bytes(3));
  });

  it("storage failure does not break reading, and one cancelled subscriber cannot cancel others", async () => {
    const cache = new ResourceCache({ get: async () => { throw Error("unavailable"); }, set: async () => { throw Error("full"); }, delete: async () => undefined });
    const controller = new AbortController();
    const task = cache.get("chapter", 1000, async () => bytes(4));
    const aborted = abortable(task, controller.signal);
    const rejection = expect(aborted).rejects.toThrow("取消");
    controller.abort();
    await rejection;
    expect(await task).toEqual(bytes(4));
  });
});
