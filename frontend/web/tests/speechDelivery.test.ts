import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCachedSpeechDurations, requestSpeech, speechKey, speechObjectBase } from "../src/reading/speech";
import { useAccountSessionStore } from "../src/account/session";

const options = { provider: "mimo", cacheVersion: "test-v1", cdnBase: "https://blacknews.jojokanbao.cn" };

async function descriptor() {
  const key = await speechKey("mimo", "test-v1", "白桦", "正文");
  return { formatVersion: "jojo-speech-segment/1", key, object: `${speechObjectBase("mimo", key)}/${"a".repeat(64)}.mp3`, duration: 12 };
}

describe("public audio delivery", () => {
  beforeEach(() => useAccountSessionStore.setState({ initialized: true, userId: "reader" }));
  afterEach(() => vi.unstubAllGlobals());

  it("uses the identical canonical hash as Python, including Unicode", async () => {
    expect(await speechKey("mimo", "test-v1", "白桦", "正文")).toBe("db63c26368279d6f69fc1dbd51d89369c2135bd0f67410a55251d38df7f955f8");
    expect(await speechKey("mimo", "test-v1", "白桦", " a\n b ")).toBe(await speechKey("mimo", "test-v1", "白桦", "a b"));
  });

  it("plays a pre-generated CDN hit without calling the API or downloading a Blob", async () => {
    const record = await descriptor();
    const fetcher = vi.fn().mockResolvedValue(Response.json(record));
    vi.stubGlobal("fetch", fetcher);
    const source = await requestSpeech("正文", "白桦", undefined, options);
    expect(source).toEqual({ url: `${options.cdnBase}/${record.object}`, duration: 12 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toMatch(/\.json$/u);
  });

  it("asks backend on a CDN miss, then uses its CDN audio path without auth headers", async () => {
    const record = await descriptor();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(Response.json(record));
    vi.stubGlobal("fetch", fetcher);
    expect(await requestSpeech("正文", "白桦", undefined, options)).toEqual({ url: `${options.cdnBase}/${record.object}`, duration: 12 });
    expect(fetcher.mock.calls[1]![0]).toBe("/api/v1/speech");
    expect(fetcher.mock.calls[1]![1].headers.Authorization).toBeUndefined();
  });

  it("does not fetch even a known public URL for a logged-out user", async () => {
    useAccountSessionStore.setState({ userId: null });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(requestSpeech("正文", "白桦", undefined, options)).rejects.toThrow("请先登录");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not trust a metadata URL outside our audio prefix", async () => {
    const record = { ...await descriptor(), object: "https://evil.invalid/audio.mp3" };
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json(record)));
    await expect(requestSpeech("正文", "白桦", undefined, options)).rejects.toThrow("无效音频地址");
  });

  it("warms real chapter durations without generating missing audio", async () => {
    const record = await descriptor();
    const fetcher = vi.fn(async (url: string) => url.includes(record.key)
      ? Response.json(record) : new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await loadCachedSpeechDurations(["正文", "尚未生成"], "白桦", new AbortController().signal, options)).toEqual({ 0: 12 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url]) => url.startsWith(options.cdnBase))).toBe(true);
  });
});
