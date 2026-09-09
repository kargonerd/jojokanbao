import { afterEach, describe, expect, it, vi } from "vitest";
import { hfProxyCacheStore } from "../src/proxy-subscription-store.js";
import { PROXY_CACHE_MAX_BYTES, proxyCacheObject } from "../src/proxy-subscription-cache.js";

const URL = "https://one.example/sub?private-token";

const hub = vi.hoisted(() => ({ downloadFile: vi.fn(), uploadFiles: vi.fn() }));
vi.mock("@huggingface/hub", () => hub);
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("bounded encrypted subscription Runtime storage", () => {
  it("isolates any number of providers and keeps caches stable across list reordering", async () => {
    const stored = new Map<string, Blob>();
    hub.downloadFile.mockImplementation(async ({ path }: { path: string }) => stored.get(path) ?? null);
    hub.uploadFiles.mockImplementation(async ({ files }: { files: Array<{ path: string; content: Blob }> }) => {
      for (const file of files) stored.set(file.path, file.content);
    });
    const urls = [URL, "https://two.example/sub", "https://three.example/sub"];
    for (const url of urls) await hfProxyCacheStore("jojo/runtime", "private-token", url).write(`ciphertext for ${url}`);
    for (const url of urls.toReversed()) expect(await hfProxyCacheStore("jojo/runtime", "private-token", url).read()).toBe(`ciphertext for ${url}`);
    expect(stored.size).toBe(3);
    for (const key of stored.keys()) expect(key).toMatch(/^times\/proxy\/subscriptions\/[a-f0-9]{64}\.v1\.json$/);
    expect(await hfProxyCacheStore("jojo/runtime", "rotated-token", URL).read()).toBeNull();
  });

  it("reads bounded data, tolerates a missing object and writes only the fixed cache slot", async () => {
    const store = hfProxyCacheStore("jojo/runtime", "private-token", URL);
    hub.downloadFile.mockResolvedValueOnce(null).mockResolvedValueOnce(new Blob(["encrypted"]));
    expect(await store.read()).toBeNull();
    expect(await store.read()).toBe("encrypted");
    hub.uploadFiles.mockResolvedValue(undefined);
    hub.downloadFile.mockResolvedValue(new Blob(["encrypted"]));
    await store.write("encrypted");
    expect(hub.uploadFiles.mock.calls[0]?.[0].files).toHaveLength(1);
    expect(hub.uploadFiles.mock.calls[0]?.[0].files[0].path).toBe(proxyCacheObject(URL, "private-token"));
    expect(hub.uploadFiles.mock.calls[0]?.[0].useWebWorkers).toBe(false);
  });

  it("does not claim a cache write succeeded when the bucket silently kept older bytes", async () => {
    hub.uploadFiles.mockResolvedValue(undefined);
    hub.downloadFile.mockResolvedValue(new Blob(["older ciphertext"]));
    await expect(hfProxyCacheStore("jojo/runtime", "private-token", URL).write("new ciphertext"))
      .rejects.toThrow(/^Proxy subscription cache unavailable$/);
  });

  it("rejects oversized metadata and streaming bodies without forwarding private SDK errors", async () => {
    const store = hfProxyCacheStore("jojo/runtime", "private-token", URL);
    hub.downloadFile.mockResolvedValueOnce({ size: PROXY_CACHE_MAX_BYTES + 1 });
    await expect(store.read()).rejects.toThrow(/^Proxy subscription cache unavailable$/);
    hub.downloadFile.mockResolvedValueOnce({ size: 1, stream: () => new Blob(["oversized"]).stream() });
    await expect(store.read()).rejects.toThrow(/^Proxy subscription cache unavailable$/);
    hub.downloadFile.mockRejectedValueOnce(new Error("https://private.example/signed?token=secret"));
    await expect(store.read()).rejects.toThrow(/^Proxy subscription cache unavailable$/);
  });

  it.each(["read", "write"] as const)("bounds a hung %s to 20 seconds and aborts SDK fetches", async (action) => {
    vi.useFakeTimers();
    const store = hfProxyCacheStore("jojo/runtime", "private-token", URL);
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_input, init) => {
      signal = init.signal;
      return new Promise(() => undefined);
    }));
    hub.downloadFile.mockImplementation(async (options) => options.fetch("https://example.test/cache"));
    hub.uploadFiles.mockImplementation(async (options) => options.fetch("https://example.test/cache"));
    const pending = expect(action === "read" ? store.read() : store.write("encrypted"))
      .rejects.toThrow(/^Proxy subscription cache unavailable$/);
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
