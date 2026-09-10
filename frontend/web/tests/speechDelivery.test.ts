import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCachedSpeechDurations, logicalSpeechVoice, requestSpeech, speechKey, speechObjectBase } from "../src/reading/speech";
import { useAccountSessionStore } from "../src/account/session";
import { useFeatureFlagStore } from "../src/featureFlags";

const options = { provider: "mimo", cacheVersion: "test-v1", cdnBase: "https://blacknews.jojokanbao.cn" };

async function descriptor() {
  const key = await speechKey("mimo", "test-v1", "白桦", "正文");
  return { formatVersion: "jojo-speech-segment/1", key, object: `${speechObjectBase("mimo", key)}/${"a".repeat(64)}.mp3`, duration: 12 };
}

describe("public audio delivery", () => {
  beforeEach(() => {
    useAccountSessionStore.setState({ initialized: true, userId: "reader" });
    useFeatureFlagStore.setState((state) => ({ flags: { ...state.flags, "reader.speech": true } }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns a progressive URL without downloading the audio and still reuses cached MP3s", async () => {
    const ticket = "a".repeat(100);
    const expiresAt = Date.now() / 1000 + 900;
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ formatVersion: "jojo-speech-stream/1", ticket, expiresAt }));
    vi.stubGlobal("fetch", fetcher);
    expect(await requestSpeech("正文", "白桦", undefined, { ...options, streaming: true })).toEqual({
      url: `/api/v1/speech/stream/?ticket=${ticket}`, duration: 0, streaming: true, expiresAt,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![0]).toBe("/api/v1/speech?stream=true");
    fetcher.mockReset().mockResolvedValue(Response.json(await descriptor()));
    const cached = await requestSpeech("正文", "白桦", undefined, { ...options, streaming: true });
    expect(cached).toMatchObject({ duration: 12 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["https://attacker.invalid/audio.mp3", "bad", "x".repeat(8193)])("rejects malformed stream tickets", async (ticket) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ formatVersion: "jojo-speech-stream/1", ticket, expiresAt: Date.now() / 1000 + 900 })));
    await expect(requestSpeech("正文", "白桦", undefined, { ...options, streaming: true })).rejects.toThrow("无效音频地址");
  });

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

  it("reuses a logical alias pointing at the existing MiMo MP3 without API synthesis", async () => {
    const original = await descriptor();
    const key = await speechKey("auto", "two-voices-v1", "male", "正文");
    const record = { ...original, sourceKey: original.key, key, provider: "mimo", voice: "male" };
    const fetcher = vi.fn(async () => Response.json(record));
    vi.stubGlobal("fetch", fetcher);
    expect(await requestSpeech("正文", "male", undefined, { ...options, provider: "auto", cacheVersion: "two-voices-v1" }))
      .toEqual({ url: `${options.cdnBase}/${original.object}`, duration: original.duration });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(logicalSpeechVoice("冰糖")).toBe("female");
    expect(logicalSpeechVoice("zh-CN-XiaoxiaoNeural")).toBe("female");
    expect(logicalSpeechVoice("白桦")).toBe("male");
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

  it("isolates news and replaces expired CDN metadata through the backend", async () => {
    const original = await descriptor();
    const record = { ...original, object: `${speechObjectBase("mimo", original.key, "news")}/${"a".repeat(64)}.mp3`, expiresAt: Date.now() / 1000 + 86400 };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ ...record, expiresAt: Date.now() / 1000 - 1 }))
      .mockResolvedValueOnce(Response.json(record));
    vi.stubGlobal("fetch", fetcher);
    expect(await requestSpeech("正文", "白桦", undefined, { ...options, scope: "news" }))
      .toEqual({ url: `${options.cdnBase}/${record.object}`, duration: 12 });
    expect(fetcher.mock.calls[0]![0]).toContain("/news/segments/");
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).scope).toBe("news");
  });

  it("does not reuse book audio for news even when text and voice match", async () => {
    const record = { ...await descriptor(), expiresAt: Date.now() / 1000 + 86400 };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(record)));
    await expect(requestSpeech("正文", "白桦", undefined, { ...options, scope: "news" })).rejects.toThrow("无效音频地址");
  });
});
