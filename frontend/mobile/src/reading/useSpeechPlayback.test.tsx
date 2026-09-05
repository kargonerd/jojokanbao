import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSpeechPlayback } from "./useSpeechPlayback";

const mocks = vi.hoisted(() => ({
  listeners: new Set<(status: Record<string, unknown>) => void>(),
  getItem: vi.fn(), setItem: vi.fn(), request: vi.fn(),
  player: { pause: vi.fn(), play: vi.fn(), replace: vi.fn(), seekTo: vi.fn(), setPlaybackRate: vi.fn(), setActiveForLockScreen: vi.fn(), addListener: vi.fn() },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: mocks.getItem, setItem: mocks.setItem } }));
vi.mock("expo-audio", () => ({ useAudioPlayer: () => mocks.player, setAudioModeAsync: async () => undefined }));
vi.mock("expo-crypto", async () => { const { createHash } = await import("node:crypto"); return { CryptoDigestAlgorithm: { SHA256: "sha256" }, digestStringAsync: async (_: string, text: string) => createHash("sha256").update(text).digest("hex") }; });
vi.mock("./speech", () => ({ mobileSpeechClient: {
  loadSpeechProviders: async () => ({ defaultProvider: "mimo", defaultVoice: "白桦", cdnBase: "https://blacknews.jojokanbao.cn", providers: [{ id: "mimo", cacheVersion: "test", available: true, voices: [{ id: "白桦" }, { id: "冰糖" }] }] }),
  requestSpeech: mocks.request, loadCachedSpeechDurations: async () => ({ 0: 20, 1: 20 }),
} }));

let state: ReturnType<typeof useSpeechPlayback>;
const props = { userId: "reader", documentId: "book", title: "书", chapterId: "c1", chapters: [{ id: "c1", title: "第一章" }, { id: "c2", title: "第二章" }],
  loadChapter: async (id: string) => ({ id, title: id, segments: ["第一段。", "第二段。"] }) };
function Harness() { state = useSpeechPlayback(props); return null; }
let view: ReactTestRenderer;
async function emit(values: Record<string, unknown> = {}) {
  await act(async () => { for (const listener of mocks.listeners) listener({ isLoaded: true, playing: false, currentTime: 0, duration: 20, didJustFinish: false, ...values }); });
}
async function play() { await act(async () => state.toggle()); await emit(); await emit({ playing: true }); }

describe("native listening lifecycle", () => {
  it("closing listening aborts prefetch, clears lock screen controls and keeps a resumable position", async () => {
    await act(async () => state.open()); await play();
    await emit({ playing: true, currentTime: 7 });
    const signal = mocks.request.mock.calls[0]![2] as AbortSignal;
    await act(async () => state.close());
    expect(signal.aborted).toBe(true);
    expect(mocks.player.setActiveForLockScreen).toHaveBeenLastCalledWith(false);
    expect(mocks.player.replace).toHaveBeenLastCalledWith(null);
    expect(state.elapsed).toBe(7);
    expect(state.playing).toBe(false);
  });
  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks(); mocks.listeners.clear();
    mocks.getItem.mockResolvedValue(null); mocks.setItem.mockResolvedValue(undefined);
    mocks.player.seekTo.mockResolvedValue(undefined);
    mocks.player.addListener.mockImplementation((_event, listener) => { mocks.listeners.add(listener); return { remove: () => mocks.listeners.delete(listener) }; });
    mocks.request.mockResolvedValue({ url: "https://blacknews.jojokanbao.cn/audio/test.mp3", duration: 20 });
    await act(async () => { view = create(<Harness />); });
  });
  afterEach(async () => { await act(async () => view.unmount()); });

  it("opens without synthesizing, starts native playback and keeps whole-chapter progress across parts", async () => {
    await act(async () => state.open());
    expect(mocks.request).not.toHaveBeenCalled();
    await play();
    expect(mocks.player.play).toHaveBeenCalledTimes(1);
    expect(mocks.player.setActiveForLockScreen).toHaveBeenCalledWith(true, expect.objectContaining({ title: "c1" }));
    await emit({ playing: true, currentTime: 12 });
    expect(state.elapsed).toBe(12);
    expect(state.duration).toBe(40);
    await emit({ didJustFinish: true, currentTime: 20 });
    await emit();
    await emit({ playing: true, currentTime: 2 });
    expect(state.part).toBe(1);
    expect(state.elapsed).toBe(22);
  });

  it("resumes the saved chapter and time, without autoplaying after reopening", async () => {
    await act(async () => state.open()); await play();
    await emit({ playing: true, currentTime: 7 });
    await act(async () => state.halt());
    const saved = mocks.setItem.mock.calls.at(-1)![1];
    expect(JSON.parse(saved).seconds).toBe(7);
    await act(async () => view.unmount());
    mocks.getItem.mockResolvedValue(saved); mocks.player.play.mockClear();
    await act(async () => { view = create(<Harness />); });
    await act(async () => state.open());
    expect(state.elapsed).toBe(7);
    expect(mocks.player.play).not.toHaveBeenCalled();
    await play();
    expect(mocks.player.seekTo).toHaveBeenLastCalledWith(7);
  });

  it("pausing while the audio request is pending does not start playback when it completes", async () => {
    let complete!: (value: { url: string; duration: number }) => void;
    mocks.request.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    await act(async () => state.open());
    await act(async () => state.toggle());
    await act(async () => state.halt());
    await act(async () => complete({ url: "https://blacknews.jojokanbao.cn/test.mp3", duration: 20 }));
    await emit();
    expect(mocks.player.play).not.toHaveBeenCalled();
  });

  it("pausing while the next chapter is loading cancels its autoplay", async () => {
    await act(async () => state.open()); await play();
    let complete!: (value: { id: string; title: string; segments: string[] }) => void;
    const load = vi.spyOn(props, "loadChapter").mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    try {
      await act(async () => { void state.selectChapter("c2", true); });
      await act(async () => state.halt());
      mocks.request.mockClear(); mocks.player.play.mockClear();
      await act(async () => complete({ id: "c2", title: "第二章", segments: ["新的正文。"] }));
      await emit();
      expect(state.chapter?.id).toBe("c2");
      expect(state.busy).toBe(false);
      expect(mocks.request).not.toHaveBeenCalled();
      expect(mocks.player.play).not.toHaveBeenCalled();
    } finally { load.mockRestore(); }
  });

  it("cancels pending synthesis on unmount and ignores its late response", async () => {
    let complete!: (value: { url: string; duration: number }) => void;
    mocks.request.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    await act(async () => state.open()); await act(async () => state.toggle());
    const signal = mocks.request.mock.calls[0]![2] as AbortSignal;
    await act(async () => view.unmount());
    expect(signal.aborted).toBe(true);
    await act(async () => complete({ url: "https://blacknews.jojokanbao.cn/test.mp3", duration: 20 }));
    expect(mocks.player.replace).not.toHaveBeenCalled();
    expect(mocks.player.play).not.toHaveBeenCalled();
  });

  it("jumps fifteen seconds across segment boundaries and stops at chapter end when requested", async () => {
    await act(async () => state.open()); await play();
    await emit({ playing: true, currentTime: 12 });
    await act(async () => state.seek(state.elapsed + 15)); await emit();
    expect(mocks.player.seekTo).toHaveBeenLastCalledWith(7);
    await act(async () => state.setTimer("chapter"));
    await emit({ playing: true, currentTime: 18 });
    await emit({ didJustFinish: true, currentTime: 20 });
    expect(state.chapter?.id).toBe("c1");
    expect(state.playing).toBe(false);
  });

  it("restarts the chapter from zero when replaying after its final segment finishes", async () => {
    await act(async () => state.open());
    await act(async () => state.selectChapter("c2")); await play();
    await emit({ didJustFinish: true, currentTime: 20 }); await emit();
    await emit({ playing: true, currentTime: 10 });
    await emit({ didJustFinish: true, currentTime: 20 });
    expect(state.elapsed).toBe(40);
    mocks.player.play.mockClear();
    await play();
    expect(state.chapter?.id).toBe("c2");
    expect(state.part).toBe(0);
    expect(state.elapsed).toBe(0);
    expect(mocks.player.seekTo).toHaveBeenLastCalledWith(0);
    expect(mocks.player.play).toHaveBeenCalledTimes(1);
  });

  it("can finish and advance again after seeking backwards within a completed segment", async () => {
    await act(async () => state.open()); await play();
    await emit({ didJustFinish: true, currentTime: 20 }); await emit();
    await act(async () => state.setTimer("chapter"));
    await emit({ playing: true, currentTime: 10 });
    await emit({ didJustFinish: true, currentTime: 20 });
    expect(state.chapter?.id).toBe("c1");
    expect(state.timer).toBe(null);
    await act(async () => state.seek(35));
    await emit({ currentTime: 15 });
    await act(async () => state.toggle());
    await emit({ playing: true, currentTime: 15 });
    await emit({ didJustFinish: true, currentTime: 20 });
    expect(state.chapter?.id).toBe("c2");
  });
});
