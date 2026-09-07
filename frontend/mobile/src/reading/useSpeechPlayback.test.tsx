import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSpeechPlayback } from "./useSpeechPlayback";
import { NativeSpeechPlayer } from "./SpeechPlayer";

const mocks = vi.hoisted(() => ({
  listeners: new Set<(status: Record<string, unknown>) => void>(),
  getItem: vi.fn(), setItem: vi.fn(), request: vi.fn(),
  preload: vi.fn(async () => undefined), clearPreloadedSource: vi.fn(async () => undefined),
  player: { pause: vi.fn(), play: vi.fn(), replace: vi.fn(), seekTo: vi.fn(), setPlaybackRate: vi.fn(), setActiveForLockScreen: vi.fn(), addListener: vi.fn() },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: mocks.getItem, setItem: mocks.setItem } }));
vi.mock("expo-audio", () => ({ useAudioPlayer: () => mocks.player, setAudioModeAsync: async () => undefined,
  preload: mocks.preload, clearPreloadedSource: mocks.clearPreloadedSource }));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return { ActivityIndicator: "progress", Image: "img", Pressable: "button", ScrollView: "section", Text: "span", View: "div",
    Modal: ({ visible, children }: { visible: boolean; children: import("react").ReactNode }) => visible ? createElement("dialog", null, children) : null,
    StyleSheet: { create: (value: unknown) => value, absoluteFillObject: {}, hairlineWidth: 1 },
    Platform: { OS: "android", select: (value: { android: string }) => value.android } };
});
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "i" }));
vi.mock("@expo/vector-icons/MaterialCommunityIcons", () => ({ default: "i" }));
vi.mock("@react-native-community/slider", () => ({ default: "input" }));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("../config/appVariant", () => ({ IS_EINK_RELEASE: false }));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "main" }));
vi.mock("../account/auth", () => ({ useMobileAuthStore: (select: (state: unknown) => unknown) => select({ user: { id: "reader" } }) }));
vi.mock("./featureFlag", () => ({ useSpeechFlagStore: () => ({ userId: "reader", enabled: true }) }));
vi.mock("expo-crypto", async () => { const { createHash } = await import("node:crypto"); return { CryptoDigestAlgorithm: { SHA256: "sha256" }, digestStringAsync: async (_: string, text: string) => createHash("sha256").update(text).digest("hex") }; });
vi.mock("./speech", () => ({ speechTime: (value: number) => String(value), mobileSpeechClient: {
  loadSpeechProviders: async () => ({ defaultProvider: "auto", defaultVoice: "male", cdnBase: "https://blacknews.jojokanbao.cn", providers: [{ id: "auto", cacheVersion: "test", available: true, voices: [{ id: "male" }, { id: "female" }] }] }),
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
    expect(mocks.player.replace).not.toHaveBeenCalledWith(null);
    expect(state.elapsed).toBe(7);
    expect(state.playing).toBe(false);
    await emit({ playing: true, didJustFinish: true, currentTime: 20 });
    expect(state.elapsed).toBe(7);
    await act(async () => state.open());
    await play();
    expect(mocks.player.seekTo).toHaveBeenLastCalledWith(7);
  });
  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks(); mocks.listeners.clear();
    mocks.getItem.mockResolvedValue(null); mocks.setItem.mockResolvedValue(undefined);
    mocks.player.seekTo.mockResolvedValue(undefined);
    // Match the native Android bridge, rather than accepting invalid null sources.
    mocks.player.replace.mockImplementation((source: { uri: string } | null) => {
      if (!source) throw new Error("Cannot convert null to AudioSource");
    });
    mocks.player.addListener.mockImplementation((_event, listener) => { mocks.listeners.add(listener); return { remove: () => mocks.listeners.delete(listener) }; });
    mocks.request.mockReset().mockImplementation(async (text: string) => ({ url: `https://blacknews.jojokanbao.cn/audio/${encodeURIComponent(text)}.mp3`, duration: 20 }));
    await act(async () => { view = create(<Harness />); });
  });
  afterEach(async () => { await act(async () => view.unmount()); });

  it.each([false, true])("can close the actual news mini player while loading=%s and reopen without blanking the article", async (loading) => {
    await act(async () => view.unmount());
    let finish: (() => void) | undefined;
    if (loading) mocks.request.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ url: "https://example.test/late.mp3", duration: 20 }); }));
    await act(async () => { view = create(<><article>新闻正文</article><NativeSpeechPlayer {...props} news documentId="news:test" onRead={() => {}} /></>); });
    const press = async (label: string) => act(async () => view.root.findByProps({ accessibilityLabel: label }).props.onPress());
    await press("打开听读播放器"); await press("开始听读");
    if (!loading) await emit({ playing: true });
    await press("收起播放器"); await press("关闭听读");
    if (finish) await act(async () => finish!());
    expect(view.root.findByType("article").props.children).toBe("新闻正文");
    expect(view.root.findAllByProps({ accessibilityLabel: "展开听读播放器" })).toHaveLength(0);
    expect(view.root.findAllByType("dialog")).toHaveLength(0);
    expect(mocks.player.replace).not.toHaveBeenCalledWith(null);
    await press("打开听读播放器");
    expect(view.root.findAllByType("dialog")).toHaveLength(1);
  });

  it("closing during synthesis cancels the request and ignores late completion", async () => {
    let finish!: (value: { url: string; duration: number }) => void;
    mocks.request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => state.open()); await act(async () => state.toggle());
    const signal = mocks.request.mock.calls[0]![2] as AbortSignal;
    await act(async () => state.close());
    expect(signal.aborted).toBe(true);
    await act(async () => finish({ url: "https://blacknews.jojokanbao.cn/late.mp3", duration: 20 }));
    await emit({ playing: true, didJustFinish: true });
    expect(mocks.player.replace).not.toHaveBeenCalled();
    expect(mocks.player.play).not.toHaveBeenCalled();
    expect(state.busy).toBe(false);
    expect(state.playing).toBe(false);
  });

  it("still dismisses when navigation has already released the native player", async () => {
    await act(async () => state.open());
    mocks.player.pause.mockImplementationOnce(() => { throw new Error("released"); });
    mocks.player.setActiveForLockScreen.mockImplementationOnce(() => { throw new Error("released"); });
    await act(async () => state.close());
    expect(state.busy).toBe(false);
    expect(state.playing).toBe(false);
  });

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

  it("buffers the next audio bytes before EOF and reuses its source without another TTS request", async () => {
    await act(async () => state.open()); await play();
    const nextUrl = `https://blacknews.jojokanbao.cn/audio/${encodeURIComponent("第二段。")}.mp3`;
    expect(mocks.preload).toHaveBeenCalledWith({ uri: nextUrl }, { preferredForwardBufferDuration: 30 });
    const requestCount = mocks.request.mock.calls.length;
    await emit({ didJustFinish: true, currentTime: 20 });
    expect(mocks.player.replace).toHaveBeenLastCalledWith({ uri: nextUrl });
    expect(mocks.request).toHaveBeenCalledTimes(requestCount);
    expect(mocks.clearPreloadedSource).not.toHaveBeenCalledWith({ uri: nextUrl });
    await act(async () => state.close());
    expect(mocks.clearPreloadedSource).toHaveBeenCalledWith({ uri: nextUrl });
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
