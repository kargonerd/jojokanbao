import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileTimesNewsItem } from "./times";

const getSession = vi.hoisted(() => vi.fn());

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
    getSession.mockResolvedValue({ data: { session: { access_token: "mobile-token" } }, error: null });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("streams a complete explanation and removes its protocol marker", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response([
      'event: status\ndata: {"provider":"test","model":"test-model"}',
      'event: text_delta\ndata: {"delta":"这是解释。<!-- JOJO_TIMES_COMPLETE -->"}',
      'event: done\ndata: {"stopReason":"stop"}',
      "",
    ].join("\n\n"), { headers: { "Content-Type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);

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
  });
});
