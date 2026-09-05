import { StrictMode, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpeechPlayer } from "../src/reading/SpeechPlayer";
import { ReadingBookshelfContext } from "../src/reading/ReadingBookshelfContext";
import { DEFAULT_SPEECH_PROVIDERS, speechSegments, splitSpeechText } from "../src/reading/speech";
import { readSpeechProgress, saveSpeechProgress, speechFingerprint } from "../src/reading/speechProgress";
import { useAccountSessionStore } from "../src/account/session";
import { useFeatureFlagStore } from "../src/featureFlags";

class AudioMock extends EventTarget {
  static instances: AudioMock[] = [];
  currentTime = 0;
  duration = 10;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  playbackRate = 1;
  preload = "";
  src: string;

  constructor(src: string) {
    super();
    this.src = src;
    AudioMock.instances.push(this);
  }

  pause = vi.fn();
  play = vi.fn(async () => { this.onloadedmetadata?.(); });
}

const capabilities = { defaultProvider: "edge", requiresAuth: false, providers: [
  ...DEFAULT_SPEECH_PROVIDERS,
  { id: "mimo", label: "小米 MiMo", description: "精品音色", available: true,
    voices: [{ id: "冰糖", label: "冰糖", description: "普通话女声" }] },
] };
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => input === "/api/v1/speech/providers"
  ? Response.json(capabilities) : new Response(new Blob(["audio"]), {
  status: 200,
  headers: { "Content-Type": "audio/mpeg" },
}));

describe("reader speech", () => {
  beforeEach(() => {
    useFeatureFlagStore.setState((state) => ({ flags: { ...state.flags, "reader.speech": true } }));
    useAccountSessionStore.setState({ initialized: true, userId: "test-reader" });
    window.localStorage.clear();
    vi.stubGlobal("Audio", AudioMock);
    fetchMock.mockClear();
    AudioMock.instances = [];
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:speech"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(() => undefined),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("splits long text at sentence boundaries and respects the request limit", () => {
    const parts = splitSpeechText(`${"很长的一句话，".repeat(30)}结束。第二句话。`, 80);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every((part) => part.length <= 80)).toBe(true);
    expect(parts.join("")).toContain("第二句话。");
  });

  it("requires login before opening listening controls or requesting audio", async () => {
    useAccountSessionStore.setState({ initialized: true, userId: null });
    render(<SpeechPlayer segments={["正文"]} label="听本章" />);
    fireEvent.click(screen.getByRole("button", { name: "打开听本章播放器" }));
    expect(screen.getByRole("dialog", { name: "登录后听读" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "开始听读" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops playback when the reader signs out", async () => {
    render(<SpeechPlayer segments={["正文"]} label="听本章" />);
    fireEvent.click(screen.getByRole("button", { name: "打开听本章播放器" }));
    fireEvent.click(screen.getByRole("button", { name: "开始听读" }));
    await waitFor(() => expect(AudioMock.instances.at(-1)?.play).toHaveBeenCalled());
    const audio = AudioMock.instances.at(-1)!;
    act(() => useAccountSessionStore.setState({ userId: null }));
    expect(audio.pause).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "暂停听读" })).toBeNull();
  });

  it("waits for delivery settings before the first audio request", async () => {
    let finish!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<SpeechPlayer segments={["正文"]} label="听本章" />);
    fireEvent.click(screen.getByRole("button", { name: "打开听本章播放器" }));
    fireEvent.click(screen.getByRole("button", { name: "开始听读" }));
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/speech")).toBe(false);
    await act(async () => finish(Response.json(capabilities)));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/speech")).toBe(true));
  });

  it("extracts readable blocks while excluding figures and notes", () => {
    const parts = speechSegments("第一章", [
      "<p>这是第一段。</p>",
      "<figure><figcaption>图片说明</figcaption></figure>",
      "<p>这是第二段。<sup>1</sup></p>",
      '<p data-role="note">不应朗读的注释。</p>',
    ].join(""), "html");

    expect(parts).toEqual(["第一章", "这是第一段。这是第二段。"]);
  });

  it("requests and starts the selected paragraph", async () => {
    render(<StrictMode><SpeechPlayer segments={["标题", "正文第一段。"]} label="听本章" /></StrictMode>);

    fireEvent.click(screen.getByRole("button", { name: "打开听本章播放器" }));
    expect(screen.getByRole("dialog", { name: "听本章播放器" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "开始听读" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/speech", expect.objectContaining({
      method: "POST",
    })));
    const request = fetchMock.mock.calls.find(([input]) => input === "/api/v1/speech")![1]!;
    expect(JSON.parse(String(request.body))).toEqual({
      text: "标题",
      voice: "zh-CN-XiaoxiaoNeural",
      provider: "edge",
    });
    expect((await screen.findAllByText("正在朗读")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "暂停听读" })).toBeTruthy();
  });

  it("opens the book chapter queue and selects another chapter", () => {
    const onChapterChange = vi.fn();
    render(<SpeechPlayer
      segments={["第一章", "正文第一段。"]}
      label="听本章"
      queueItems={[
        { id: "one", title: "第一章" },
        { id: "two", title: "第二章" },
      ]}
      activeQueueId="one"
      onQueueItemChange={onChapterChange}
    />);

    fireEvent.click(screen.getByRole("button", { name: "打开听本章播放器" }));
    expect(screen.queryByRole("complementary", { name: "章节列表" })).toBeNull();
    expect(screen.getAllByText("准备播放").length).toBeGreaterThan(0);
    expect(screen.queryByText("在线生成")).toBeNull();
    const queueButton = screen.getByRole("button", { name: "打开章节列表" });
    fireEvent.click(queueButton);
    expect(screen.getByRole("complementary", { name: "章节列表" })).toBeTruthy();
    expect(queueButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "关闭章节列表" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /02 第二章/ }));
    expect(onChapterChange).toHaveBeenCalledWith("two");
    expect(queueButton.getAttribute("aria-expanded")).toBe("false");
  });

  it("uses the reader bookshelf action inside the player", () => {
    const toggle = vi.fn();
    render(
      <ReadingBookshelfContext.Provider value={{ available: true, added: false, busy: false, toggle }}>
        <SpeechPlayer segments={["第一章", "正文第一段。"]} label="听本章" />
      </ReadingBookshelfContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "打开听本章播放器" }));
    fireEvent.click(screen.getByRole("button", { name: "加入书架" }));
    expect(toggle).toHaveBeenCalledOnce();
  });

  it("uses a custom timer sheet instead of a native select", () => {
    render(<SpeechPlayer segments={["第一章", "正文第一段。"]} label="听本章" />);

    fireEvent.click(screen.getByRole("button", { name: "打开听本章播放器" }));
    fireEvent.click(screen.getByRole("button", { name: "设置定时关闭" }));
    expect(screen.getByRole("dialog", { name: "定时关闭设置" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "15 分钟" }));

    expect(screen.queryByRole("dialog", { name: "定时关闭设置" })).toBeNull();
    expect(screen.getByRole("button", { name: "设置定时关闭" }).textContent).toContain("15 分钟");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("switches provider and sends MiMo voice without a client key", async () => {
    render(<SpeechPlayer segments={["测试原文"]} label="听本章" />);
    fireEvent.click(screen.getByRole("button", { name: "打开听本章播放器" }));
    fireEvent.click(screen.getByRole("button", { name: "选择听读声音" }));
    fireEvent.click(await screen.findByRole("button", { name: "冰糖 普通话女声" }));
    fireEvent.click(screen.getByRole("button", { name: "开始听读" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/speech", expect.objectContaining({
      body: JSON.stringify({ text: "测试原文", voice: "冰糖", provider: "mimo" }),
    })));
    expect(window.localStorage.getItem("jojo-reader-speech-voice:听本章:provider")).toBe(JSON.stringify({ provider: "mimo", voice: "冰糖" }));
  });

  it("does not restart playback on a parent rerender or a timer setting", async () => {
    const view = render(<SpeechPlayer segments={["测试原文"]} label="听本章" onQueueItemChange={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "打开听本章播放器" }));
    fireEvent.click(screen.getByRole("button", { name: "开始听读" }));
    await waitFor(() => expect(AudioMock.instances.at(-1)?.play).toHaveBeenCalled());
    const audio = AudioMock.instances.at(-1)!;
    audio.currentTime = 5;
    view.rerender(<SpeechPlayer segments={["测试原文"]} label="听本章" onQueueItemChange={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "设置定时关闭" }));
    fireEvent.click(screen.getByRole("button", { name: /本篇结束后停止/ }));
    expect(AudioMock.instances.at(-1)).toBe(audio);
    expect(audio.currentTime).toBe(5);
    expect(audio.pause).not.toHaveBeenCalled();
  });

  it("previous and next controls select chapters rather than synthesis chunks", () => {
    const select = vi.fn();
    render(<SpeechPlayer segments={["标题", "段落一", "段落二"]} label="听本章"
      queueItems={[{id:"a",title:"第一章"},{id:"b",title:"第二章"}]} activeQueueId="a" onQueueItemChange={select} />);
    fireEvent.click(screen.getByRole("button", { name: "打开听本章播放器" }));
    fireEvent.click(screen.getByRole("button", { name: "下一章" }));
    expect(select).toHaveBeenCalledWith("b");
  });

  it("returns focus to the mini player after Escape", () => {
    render(<SpeechPlayer segments={["测试"]} label="听本章" />);
    const launcher = screen.getByRole("button", { name: "打开听本章播放器" });
    fireEvent.click(launcher);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "展开播放器：测试" }));
  });

  it("shows voice names without provider headings", async () => {
    render(<SpeechPlayer segments={["测试"]} label="听新闻" />);
    fireEvent.click(screen.getByRole("button", { name: "打开听新闻播放器" }));
    fireEvent.click(screen.getByRole("button", { name: "选择听读声音" }));
    await screen.findByRole("button", { name: "冰糖 普通话女声" });
    expect(screen.queryByText(/Microsoft|MiMo|未配置/)).toBeNull();
  });

  it("keeps audio when collapsed and pauses/resumes from the mini player", async () => {
    render(<SpeechPlayer contentId="mini" segments={["测试正文"]} label="听新闻" />);
    fireEvent.click(screen.getByRole("button", { name: "打开听新闻播放器" }));
    fireEvent.click(screen.getByRole("button", { name: "开始听读" }));
    await waitFor(() => expect(AudioMock.instances.at(-1)?.play).toHaveBeenCalled());
    const audio = AudioMock.instances.at(-1)!;
    audio.currentTime = 4;
    fireEvent.click(screen.getByRole("button", { name: "收起听读播放器" }));
    expect(screen.getByRole("region", { name: "迷你听读播放器" })).toBeTruthy();
    expect(audio.pause).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "暂停听读" }));
    expect(readSpeechProgress("mini")?.fraction).toBe(.4);
    fireEvent.click(screen.getByRole("button", { name: "继续听读" }));
    await waitFor(() => expect(AudioMock.instances.at(-1)?.play).toHaveBeenCalled());
    expect(AudioMock.instances).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "关闭迷你播放器" }));
    expect(screen.queryByRole("region", { name: "迷你听读播放器" })).toBeNull();
    expect(document.body.dataset.speechMini).toBeUndefined();
  });

  it("hides reader mini chrome without stopping or recreating audio", async () => {
    const controls = { available: false, added: false, busy: false, toggle: () => undefined };
    const player = <SpeechPlayer contentId="reader-chrome" segments={["测试正文"]} label="听本章" />;
    const view = render(<ReadingBookshelfContext.Provider value={controls}>{player}</ReadingBookshelfContext.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "打开听本章播放器" }));
    fireEvent.click(screen.getByRole("button", { name: "开始听读" }));
    await waitFor(() => expect(AudioMock.instances[0]?.play).toHaveBeenCalled());
    const audio = AudioMock.instances[0]!;
    fireEvent.click(screen.getByRole("button", { name: "收起听读播放器" }));
    const pauses = audio.pause.mock.calls.length;

    view.rerender(<ReadingBookshelfContext.Provider value={{ ...controls, chromeHidden: true }}>{player}</ReadingBookshelfContext.Provider>);
    expect(screen.queryByRole("region", { name: "迷你听读播放器" })).toBeNull();
    expect(document.querySelector(".speech-mini")?.hasAttribute("inert")).toBe(true);
    expect(document.body.dataset.speechMini).toBe("reader");
    expect(audio.pause).toHaveBeenCalledTimes(pauses);
    expect(AudioMock.instances).toHaveLength(1);

    view.rerender(<ReadingBookshelfContext.Provider value={controls}>{player}</ReadingBookshelfContext.Provider>);
    expect(screen.getByRole("region", { name: "迷你听读播放器" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "暂停听读" })).toBeTruthy();
    expect(audio.pause).toHaveBeenCalledTimes(pauses);
  });

  it("makes no network requests and renders no launcher with the rollout flag off", () => {
    useFeatureFlagStore.setState((state) => ({ flags: { ...state.flags, "reader.speech": false } }));
    const { container } = render(<SpeechPlayer segments={["正文"]} label="听本章" />);
    expect(container.childElementCount).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops playback when the rollout flag is disabled", async () => {
    render(<SpeechPlayer segments={["正文"]} label="听本章" />);
    fireEvent.click(screen.getByRole("button", { name: "打开听本章播放器" }));
    fireEvent.click(screen.getByRole("button", { name: "开始听读" }));
    await waitFor(() => expect(AudioMock.instances.at(-1)?.play).toHaveBeenCalled());
    const audio = AudioMock.instances.at(-1)!;
    act(() => useFeatureFlagStore.setState((state) => ({ flags: { ...state.flags, "reader.speech": false } })));
    expect(audio.pause).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "暂停听读" })).toBeNull();
  });

  it("docks the mini player in its host without moving the full player or restarting audio", async () => {
    function DockedPlayer() {
      const [target, setTarget] = useState<HTMLDivElement | null>(null);
      return <section aria-label="文章正文">
        <div data-testid="article-scroll">
          <SpeechPlayer contentId="docked" segments={["测试正文"]} label="听新闻" miniPlayerTarget={target} />
        </div>
        <div ref={setTarget} data-testid="article-footer" />
      </section>;
    }
    render(<DockedPlayer />);
    const footer = screen.getByTestId("article-footer");
    expect(within(footer).getByRole("button", { name: "打开听新闻播放器" }).closest(".speech-player")?.classList.contains("is-docked")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "打开听新闻播放器" }));
    expect(within(screen.getByRole("region", { name: "文章正文" })).queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "开始听读" }));
    await waitFor(() => expect(AudioMock.instances.at(-1)?.play).toHaveBeenCalled());
    const audio = AudioMock.instances.at(-1)!;
    fireEvent.click(screen.getByRole("button", { name: "收起听读播放器" }));

    expect(within(footer).getByRole("region", { name: "迷你听读播放器" }).classList.contains("is-docked")).toBe(true);
    expect(within(footer).queryByRole("button", { name: "打开听新闻播放器" })).toBeNull();
    expect(within(screen.getByTestId("article-scroll")).queryByRole("region", { name: "迷你听读播放器" })).toBeNull();
    expect(document.body.dataset.speechMini).toBe("docked");
    expect(audio.pause).not.toHaveBeenCalled();
    fireEvent.click(within(footer).getByRole("button", { name: /展开播放器/ }));
    expect(within(footer).queryByRole("region", { name: "迷你听读播放器" })).toBeNull();
    expect(document.body.dataset.speechMini).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "收起听读播放器" }));
    expect(AudioMock.instances).toHaveLength(1);
    fireEvent.click(within(footer).getByRole("button", { name: "关闭迷你播放器" }));
    expect(within(footer).getByRole("button", { name: "打开听新闻播放器" })).toBeTruthy();
    expect(within(footer).queryByRole("region", { name: "迷你听读播放器" })).toBeNull();
    expect(document.body.dataset.speechMini).toBeUndefined();
  });

  it("restores listening position after remount without autoplay", async () => {
    const props = { contentId: "resume-book", segments: ["正文"], label: "听本章", activeQueueId: "one" };
    const view = render(<SpeechPlayer {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "打开听本章播放器" }));
    fireEvent.click(screen.getByRole("button", { name: "开始听读" }));
    await waitFor(() => expect(AudioMock.instances.at(-1)?.play).toHaveBeenCalled());
    const audio = AudioMock.instances.at(-1)!;
    audio.currentTime = 6;
    act(() => audio.ontimeupdate?.());
    view.unmount();
    render(<SpeechPlayer {...props} />);
    expect(AudioMock.instances).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "打开听本章播放器" }));
    expect(screen.getByText("从上次听到的位置继续")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "开始听读" }));
    await waitFor(() => expect(AudioMock.instances).toHaveLength(2));
    expect(AudioMock.instances.at(-1)?.currentTime).toBe(6);
  });

  it("returns to the last listened chapter only when the user opens listening", () => {
    saveSpeechProgress("book", { chapterId: "two", fingerprint: speechFingerprint("第二章"), segmentIndex: 0, fraction: .5, provider: "edge", voice: "zh-CN-XiaoxiaoNeural", updatedAt: Date.now() });
    const change = vi.fn();
    const view = render(<SpeechPlayer contentId="book" segments={["第一章"]} label="听本章" activeQueueId="one" queueItems={[{id:"one", title:"第一章"}, {id:"two", title:"第二章"}]} onQueueItemChange={change} />);
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "打开听本章播放器" }));
    expect(change).toHaveBeenCalledWith("two");
    view.rerender(<SpeechPlayer contentId="book" segments={["第二章"]} label="听本章" activeQueueId="two" />);
    expect(screen.getByText("从上次听到的位置继续")).toBeTruthy();
  });

  it("discards old progress when text changes or saved data is invalid", () => {
    saveSpeechProgress("updated", { fingerprint: speechFingerprint("旧内容"), segmentIndex: 0, fraction: .5, provider: "edge", voice: "zh-CN-XiaoxiaoNeural", updatedAt: Date.now() });
    render(<SpeechPlayer contentId="updated" segments={["新内容"]} label="听本章" />);
    fireEvent.click(screen.getByRole("button", { name: "打开听本章播放器" }));
    expect(screen.getByText("准备播放")).toBeTruthy();
    localStorage.setItem("jojo-speech-progress:v1", '{"invalid":{"fraction":2}}');
    expect(readSpeechProgress("invalid")).toBeUndefined();
  });

  it("uses the news logo when the lead image fails", () => {
    render(<SpeechPlayer segments={["新闻"]} label="听新闻" artworkUrl="/lead.jpg" artworkFallbackUrl="/logo.png" />);
    fireEvent.click(screen.getByRole("button", { name: "打开听新闻播放器" }));
    const artwork = document.querySelector<HTMLImageElement>(".speech-player__artwork img")!;
    expect(artwork.getAttribute("src")).toBe("/lead.jpg");
    fireEvent.error(artwork);
    expect(artwork.getAttribute("src")).toBe("/logo.png");
    expect(document.querySelector(".speech-player__ambience img")?.getAttribute("src")).toBe("/logo.png");
    fireEvent.error(artwork);
    expect(document.querySelector(".speech-player__artwork img")).toBeNull();
    expect(screen.getAllByText("JOJO 时事").length).toBeGreaterThan(0);
  });

  it("carries cover ambience into the mini player and follows its image fallback", () => {
    render(<SpeechPlayer segments={["新闻"]} label="听新闻" artworkUrl="/lead.jpg" artworkFallbackUrl="/logo.png" />);
    fireEvent.click(screen.getByRole("button", { name: "打开听新闻播放器" }));
    fireEvent.click(screen.getByRole("button", { name: "收起听读播放器" }));
    const ambience = document.querySelector(".speech-mini__ambience")!;
    expect(ambience.getAttribute("aria-hidden")).toBe("true");
    expect(ambience.querySelector("img")?.getAttribute("src")).toBe("/lead.jpg");
    fireEvent.error(document.querySelector(".speech-mini__cover img")!);
    expect(ambience.querySelector("img")?.getAttribute("src")).toBe("/logo.png");
    fireEvent.error(document.querySelector(".speech-mini__cover img")!);
    expect(document.querySelector(".speech-mini__ambience")).toBeNull();
    expect(screen.getByRole("button", { name: "继续听读" })).toBeTruthy();
  });
});
