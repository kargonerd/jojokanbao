import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileTimesNewsItem } from "./times";

const getSession = vi.hoisted(() => vi.fn());
const streamingFetch = vi.hoisted(() => vi.fn());
vi.mock("expo/fetch", () => ({ fetch: streamingFetch }));

vi.mock("../account/auth", () => ({
  mobileAuthClient: { auth: { getSession } },
}));

import { explainMobileTimesSelection } from "./timesAgent";

const news = {
  id: "news-1",
  title: "测试新闻",
  contentStatus: "full",
  publishedAt: "2026-09-03T00:00:00.000Z",
  issueDate: "20260903",
  language: "zh-CN",
  originalLanguage: "zh-CN",
  translationAvailable: false,
  usingTranslation: false,
  source: { id: "example", name: "测试媒体", language: "zh-CN" },
  articleObject: "content/newspapers/example/articles/news-1.jox",
  assets: [],
  contentFormat: "html",
  content: "<p>这是新闻正文。</p>",
} satisfies MobileTimesNewsItem;

describe("mobile times agent", () => {
  beforeEach(() => {
    getSession.mockReset();
    streamingFetch.mockReset();
    getSession.mockResolvedValue({ data: { session: { access_token: "mobile-token" } }, error: null });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("streams a complete explanation and removes its protocol marker", async () => {
    const fetchMock = streamingFetch.mockResolvedValue(new Response([
      'event: status\ndata: {"provider":"test","model":"test-model"}',
      'event: text_delta\ndata: {"delta":"这是解释。<!-- JOJO_TIMES_COMPLETE -->"}',
      'event: done\ndata: {"stopReason":"stop"}',
      "",
    ].join("\n\n"), { headers: { "Content-Type": "text/event-stream" } }));
    const nativeFetch = vi.fn().mockResolvedValue({ ok: true, body: undefined });
    vi.stubGlobal("fetch", nativeFetch);

    const completed = await new Promise<{ answer: string; imageCount: number }>((resolve, reject) => {
      explainMobileTimesSelection(news, { quote: "新闻正文" }, {
        onStatus: vi.fn(),
        onChunk: vi.fn(),
        onDone: (metadata, answer) => resolve({ answer, imageCount: metadata.imageCount }),
        onError: reject,
      });
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://agent-global.jojokanbao.cn/times");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer mobile-token");
    expect(completed).toEqual({ answer: "这是解释。", imageCount: 0 });
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['event: error\ndata: {"message":"服务繁忙"}\n\n', "服务繁忙"],
    ['event: text_delta\ndata: {"delta":"不完整的回答"}\n\nevent: done\ndata: {}\n\n', "AI 解释似乎没有生成完整，请重试"],
    ['event: text_delta\ndata: {"delta":"回答"}\n\nevent: done\ndata: {"stopReason":"length"}\n\n', "AI 解释生成到一半就停止了，请重试"],
  ])("reports a failed stream instead of completing it", async (body, error) => {
    streamingFetch.mockResolvedValue(new Response(body));
    const onDone = vi.fn();
    const result = await new Promise<string>((resolve) => {
      explainMobileTimesSelection(news, { quote: "新闻正文" }, { onStatus: vi.fn(), onChunk: vi.fn(), onDone, onError: resolve });
    });
    expect(result).toBe(error);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("sends follow-up history and retains the original news and quote", async () => {
    streamingFetch.mockResolvedValue(new Response('event: text_delta\ndata: {"delta":"后续解释。<!-- JOJO_TIMES_COMPLETE -->"}\n\nevent: done\ndata: {"stopReason":"stop"}\n\n'));
    const history = [{ role: "user" as const, content: "解释正文" }, { role: "assistant" as const, content: "这是背景。" }];
    await new Promise<void>((resolve, reject) => {
      explainMobileTimesSelection(news, { quote: "新闻正文" }, { onStatus: vi.fn(), onChunk: vi.fn(), onDone: () => resolve(), onError: reject },
        { question: "再举个例子", history, conversationId: "times_followup" });
    });
    const init = streamingFetch.mock.calls[0]![1];
    const body = JSON.parse(init.body);
    expect(body.history).toEqual(history);
    expect(body.message).toContain("测试新闻");
    expect(body.message).toContain("新闻正文");
    expect(body.message).toContain("再举个例子");
    expect(new Headers(init.headers).get("makers-conversation-id")).toBe("times_followup");
  });
});
