import { gzipSync } from "node:zlib";
import { transformJoxBytes, type ResourceCacheEntry, type TimesDeliveryArticle } from "@jojo/content";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const entries = vi.hoisted(() => new Map<string, ResourceCacheEntry>());
vi.mock("./contentCache", () => ({ mobileContentCache: () => ({
  get: async (key: string) => entries.get(key),
  set: async (key: string, entry: ResourceCacheEntry) => { entries.set(key, entry); },
  delete: async (key: string) => { entries.delete(key); },
}) }));
const article: TimesDeliveryArticle = { id: "news-1", issueDate: "20260909", title: "旧新闻", language: "zh-CN",
  source: { id: "example", name: "媒体", language: "zh-CN" }, publishedAt: "2026-09-09T00:00:00Z", contentStatus: "full",
  articleObject: "content/newspapers/example/articles/news-1.jox", assets: [],
};
const initialIndex = { formatVersion: "jojo-news-timeline-index/1", updatedAt: "2026-09-09T01:00:00Z", sources: [article.source],
  dates: [{ date: article.issueDate, object: "day.jox", articleCount: 1, pages: [{ object: "page.jox", articleCount: 1 }] }],
};
function onlineFetch(input: RequestInfo | URL) {
  const key = new URL(String(input)).pathname.slice(1);
  const data = key.endsWith("index.jox") ? initialIndex : key.endsWith("page.jox")
    ? { formatVersion: "jojo-news-timeline-page/1", date: article.issueDate, page: 0, updatedAt: initialIndex.updatedAt, articles: [article] }
    : { formatVersion: "jojo-fragment/1", type: "article", fragmentId: article.id, title: article.title,
      body: { format: "text", value: "已经读过的正文" }, assetRefs: [] };
  return Promise.resolve(new Response(transformJoxBytes(gzipSync(JSON.stringify(data)), key).slice().buffer));
}
beforeEach(() => { entries.clear(); vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("offline times content", () => {
  it("restores the visible feed and read article after restart and expiry without waiting for network", async () => {
    vi.stubGlobal("fetch", onlineFetch);
    const online = (await import("./times")).mobileTimesApi;
    const feed = await online.latestTimeline();
    online.saveTimeline(feed);
    expect((await online.getNews(article.issueDate, article.id)).content).toBe("已经读过的正文");
    vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(Date.now() + 30 * 86400_000);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const offline = (await import("./times")).mobileTimesApi;
    expect((await offline.cachedTimeline())?.pages[0]?.articles[0]?.title).toBe("旧新闻");
    expect((await offline.getNews(article.issueDate, article.id)).content).toBe("已经读过的正文");
    await expect(offline.latestTimeline(true)).rejects.toThrow("offline");
    expect((await offline.cachedTimeline())?.pages[0]?.articles[0]?.title).toBe("旧新闻");
  });

  it("preserves the complete previous feed when a refresh gets a new index but its page fails", async () => {
    vi.stubGlobal("fetch", onlineFetch);
    const api = (await import("./times")).mobileTimesApi;
    api.saveTimeline(await api.latestTimeline());
    const nextIndex = { ...initialIndex, updatedAt: "2026-09-09T02:00:00Z", dates: [
      { ...initialIndex.dates[0]!, pages: [{ object: "new-page.jox", articleCount: 1 }] },
    ] };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const key = new URL(String(input)).pathname.slice(1);
      if (key.endsWith("index.jox")) return new Response(transformJoxBytes(gzipSync(JSON.stringify(nextIndex)), key).slice().buffer);
      throw new Error("offline");
    }));
    await expect(api.latestTimeline(true)).rejects.toThrow("offline");
    vi.resetModules();
    expect((await (await import("./times")).mobileTimesApi.cachedTimeline())?.index.updatedAt).toBe(initialIndex.updatedAt);
  });
});
