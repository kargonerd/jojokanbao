import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverSiteAdapter } from "../src/discovery/site-adapter.js";
import type { SourceConfig } from "../src/types.js";

const source: SourceConfig = {
  id: "example",
  name: "Example",
  language: "en",
  discovery: {
    kind: "site-adapter",
    adapter: "html-news-page",
    url: "https://example.test/world",
    articlePathPrefixes: ["/articles/"],
    maximumItems: 20,
  },
  content: { priority: ["discovery-body", "discovery-summary"], minimumFullCharacters: 20, minimumFullParagraphs: 1 },
  archive: { mode: "browser", bpc: true },
  health: { minimumCandidates: 1 },
  enabled: true,
};

afterEach(() => vi.unstubAllGlobals());

describe("HTML news page adapter", () => {
  it("discovers same-origin articles and maps NewsArticle JSON-LD", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/world")) {
        return new Response('<a href="/articles/one">One</a><a href="https://outside.test/articles/two">Outside</a>', { status: 200 });
      }
      return new Response(`<script type="application/ld+json">${JSON.stringify({
        "@type": "NewsArticle",
        headline: "One",
        datePublished: "2026-08-25T05:00:00Z",
        url: "https://example.test/articles/one?utm_source=test",
        articleBody: "This is a complete article body for the adapter test.",
        articleSection: "World",
        author: { name: "Reporter" },
      })}</script>`, { status: 200 });
    }));

    const result = await discoverSiteAdapter(source, "2026-08-25T05:10:00Z");

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      title: "One",
      canonicalUrl: "https://example.test/articles/one",
      contentStatus: "full",
      authors: ["Reporter"],
      publisherCategories: ["World"],
    });
  });

  it("supports an HTTP listing with HTTPS links and Chinese article timestamps", async () => {
    const chinese: SourceConfig = {
      ...source,
      id: "people",
      language: "zh-CN",
      discovery: {
        kind: "site-adapter",
        adapter: "html-news-page",
        url: "http://news.example.test/",
        articlePathPrefixes: ["/n1/"],
        maximumItems: 20,
      },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "http://news.example.test/") {
        return new Response('<a href="https://news.example.test/n1/2026/0825/story.html">Story</a>', { status: 200 });
      }
      expect(url).toBe("http://news.example.test/n1/2026/0825/story.html");
      return new Response(`
        <h1><img alt="logo"></h1><h1>真正的文章标题</h1>
        <span class="pubtime"></span><b id="newstime">2026年08月25日08:44</b>
        <div id="rwb_zw"><p>这是足够长的文章正文段落，用于验证来源页面解析。</p></div>
      `, { status: 200 });
    }));

    const result = await discoverSiteAdapter(chinese, "2026-08-25T05:10:00Z");

    expect(result.candidates[0]).toMatchObject({
      title: "真正的文章标题",
      publishedAt: "2026-08-25T00:44:00.000Z",
    });
  });

  it("uses The Paper channel API directly and excludes video details", async () => {
    const thepaper: SourceConfig = {
      ...source,
      id: "thepaper",
      name: "澎湃新闻",
      language: "zh-CN",
      discovery: { kind: "site-adapter", adapter: "thepaper-channel", channelId: "25950", maximumItems: 20 },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("getByChannelId")) {
        return Response.json({ data: { list: [
          { contId: "one", name: "One", pubTimeLong: 1_787_634_600_000 },
          { contId: "video", name: "Video", pubTimeLong: 1_787_634_600_000 },
        ] } });
      }
      const video = url.endsWith("/video");
      return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: { pageProps: { detailData: { contentDetail: {
          name: video ? "Video" : "One",
          publishTime: 1_787_634_600_000,
          content: "<p>This is a complete article body for The Paper adapter test.</p>",
          summary: "Summary",
          author: "Reporter",
          nodeInfo: { name: "时事" },
          tagList: [{ tag: "法律" }],
          videoDTOList: video ? [{ url: "https://video.test/one.mp4" }] : [],
        } } } },
      })}</script>`, { status: 200 });
    }));

    const result = await discoverSiteAdapter(thepaper, "2026-08-25T05:10:00Z");

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      canonicalUrl: "https://www.thepaper.cn/newsDetail_forward_one",
      contentStatus: "full",
      publisherCategories: ["时事", "法律"],
    });
    expect(result.upstream).toMatchObject({ skippedVideoCount: 1 });
  });
});
