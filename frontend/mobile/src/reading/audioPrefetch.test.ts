import { describe, expect, it, vi } from "vitest";
import { AudioPrefetch } from "./audioPrefetch";

const mocks = vi.hoisted(() => ({ preload: vi.fn(), clear: vi.fn(async () => undefined) }));
vi.mock("expo-audio", () => ({ preload: mocks.preload, clearPreloadedSource: mocks.clear }));
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("native audio byte prefetch lifetime", () => {
  it("limits downloads and releases a late result after switching voice or closing", async () => {
    mocks.preload.mockReset(); mocks.clear.mockClear();
    const finish = new Map<string, () => void>();
    mocks.preload.mockImplementation(({ uri }: { uri: string }) => new Promise<void>((resolve) => finish.set(uri, resolve)));
    const cache = new AudioPrefetch();
    cache.retain("current", ["next", "after-next"]);
    cache.retain("new-voice", ["female"]);
    expect(mocks.preload).toHaveBeenCalledTimes(2);
    finish.get("next")!(); await tick();
    expect(mocks.clear).toHaveBeenCalledWith({ uri: "next" });
    expect(mocks.preload).toHaveBeenCalledTimes(3);
    cache.retain();
    finish.get("after-next")!(); finish.get("female")!(); await tick();
    expect(mocks.clear).toHaveBeenCalledWith({ uri: "after-next" });
    expect(mocks.clear).toHaveBeenCalledWith({ uri: "female" });
  });

  it("keeps ready next segments while moving forwards without downloading them twice", async () => {
    mocks.preload.mockReset().mockResolvedValue(undefined); mocks.clear.mockClear();
    const cache = new AudioPrefetch();
    cache.retain("one", ["two", "three"]); await tick();
    cache.retain("two", ["three", "four"]); await tick();
    expect(mocks.preload.mock.calls.map(([source]) => source.uri)).toEqual(["two", "three", "four"]);
    expect(mocks.clear).not.toHaveBeenCalledWith({ uri: "two" });
    cache.retain("three", ["four"]);
    expect(mocks.clear).toHaveBeenCalledWith({ uri: "two" });
  });
});
