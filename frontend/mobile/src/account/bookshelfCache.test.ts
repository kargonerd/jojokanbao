import { afterEach, describe, expect, it, vi } from "vitest";
import { createBookshelfCache } from "./bookshelfCache";

const entry = { datasetId: "book", itemId: "book:full", title: "测试书" };
function setup() {
  const disk = new Map<string, string>();
  const storage = { getItem: async (key: string) => disk.get(key) ?? null,
    setItem: async (key: string, value: string) => { disk.set(key, value); } };
  const auth = { userId: "reader" as string | undefined };
  const loadRemote = vi.fn().mockResolvedValue([entry]);
  const writeRemote = vi.fn().mockResolvedValue(undefined);
  const create = () => createBookshelfCache({ userId: () => auth.userId, storage, loadRemote, writeRemote });
  return { auth, disk, loadRemote, writeRemote, create };
}
afterEach(() => vi.useRealTimers());

describe("offline account bookshelf", () => {
  it("shows the persisted shelf immediately after restart while the network is stalled", async () => {
    const env = setup();
    await env.create().load();
    await vi.waitFor(() => expect(env.disk.size).toBe(1));
    vi.useFakeTimers();
    env.loadRemote.mockReturnValue(new Promise(() => undefined));
    const onError = vi.fn();
    expect(await env.create().load({ onError })).toEqual([entry]);
    await vi.advanceTimersByTimeAsync(12_001);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("updates the displayed and persisted shelf after reconnection, including an empty remote shelf", async () => {
    const env = setup();
    const cache = env.create();
    await cache.load();
    env.loadRemote.mockRejectedValueOnce(new Error("offline"));
    const failed = vi.fn();
    expect(await cache.load({ onError: failed })).toEqual([entry]);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    env.loadRemote.mockResolvedValue([]);
    const onUpdate = vi.fn();
    expect(await cache.load({ onUpdate })).toEqual([entry]);
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledWith([]));
    await vi.waitFor(() => expect([...env.disk.values()]).toEqual(["[]"]));
  });

  it("isolates accounts and discards a late callback after logout", async () => {
    const env = setup(); const cache = env.create();
    await cache.load();
    let finish!: (value: unknown) => void;
    env.loadRemote.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const onUpdate = vi.fn();
    await cache.load({ onUpdate });
    env.auth.userId = undefined;
    finish([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onUpdate).not.toHaveBeenCalled();
    await expect(cache.load()).rejects.toThrow("登录");
    env.auth.userId = "someone-else";
    env.loadRemote.mockRejectedValueOnce(new Error("offline"));
    await expect(cache.load()).rejects.toThrow("offline");
  });

  it("does not let an older refresh undo a confirmed removal", async () => {
    const env = setup(); const cache = env.create();
    await cache.load();
    let finish!: (value: unknown) => void;
    env.loadRemote.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const update = vi.fn();
    await cache.load({ onUpdate: update });
    await cache.set({ ...entry, added: false });
    finish([entry]);
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith([]));
    expect([...env.disk.values()]).toEqual(["[]"]);
  });

  it("keeps the cached entry when removing it fails offline", async () => {
    const env = setup(); const cache = env.create();
    await cache.load();
    env.writeRemote.mockRejectedValueOnce(new Error("offline"));
    await expect(cache.set({ ...entry, added: false })).rejects.toThrow("offline");
    expect(await cache.load()).toEqual([entry]);
  });
});
