import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverHtmlListing } from "../src/discovery/html-listing.js";
import { discoverPeople } from "../src/sources/people/discover.js";
import { discoverXinhua } from "../src/sources/xinhua/discover.js";
import type { RouteDiscoveryEndpoint, SourceConfig } from "../src/types.js";

const endpoint: RouteDiscoveryEndpoint = {
  kind: "source-adapter",
  adapter: "africanews",
  driver: "http",
  route: "markets",
  maximumItems: 20,
};

const source: SourceConfig = {
  id: "africanews",
  name: "Example",
  language: "en",
  publicationTimeZone: "UTC",
  sections: [{ id: "markets", name: "Markets", url: "https://example.test/world" }],
  discovery: endpoint,
  content: { priority: ["discovery-body", "discovery-summary"], minimumFullCharacters: 20, minimumFullParagraphs: 1 },
  fetch: { strategy: "direct-first", bpc: true },
  health: { minimumCandidates: 1 },
  enabled: true,
};

afterEach(() => vi.unstubAllGlobals());

describe("HTML listing discovery mechanics", () => {
  it("discovers same-origin articles and maps standard NewsArticle JSON-LD", async () => {
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

    const result = await discoverHtmlListing(source, "2026-08-25T05:10:00Z", {
      listingUrl: "https://example.test/world",
      articlePathPrefixes: ["/articles/"],
      maximumItems: 20,
      version: "test/1",
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      title: "One",
      canonicalUrl: "https://example.test/articles/one",
      contentStatus: "full",
      authors: ["Reporter"],
      publisherCategories: ["World"],
    });
  });

  it("keeps People's protocol and Chinese timestamp rules in its source module", async () => {
    const peopleEndpoint: RouteDiscoveryEndpoint = {
      kind: "source-adapter",
      adapter: "people",
      driver: "http",
      route: "politics",
      maximumItems: 20,
    };
    const people: SourceConfig = {
      ...source,
      id: "people",
      language: "zh-CN",
      publicationTimeZone: "Asia/Shanghai",
      sections: [{ id: "politics", name: "时政", url: "https://news.example.test/" }],
      discovery: peopleEndpoint,
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "http://news.example.test/") {
        return new Response('<a href="https://news.example.test/n1/2026/0825/story.html">Story</a>', { status: 200 });
      }
      expect(url).toBe("http://news.example.test/n1/2026/0825/story.html");
      return new Response(`
        <h1><img alt="logo"></h1><h1>真正的文章标题</h1>
        <b id="newstime">2026年08月25日08:44</b>
        <div id="rwb_zw"><p>这是足够长的文章正文段落，用于验证来源页面解析。</p></div>
      `, { status: 200 });
    }));

    const result = await discoverPeople(people, peopleEndpoint, "2026-08-25T05:10:00Z");

    expect(result.candidates[0]).toMatchObject({
      title: "真正的文章标题",
      publishedAt: "2026-08-25T00:44:00.000Z",
    });
  });

  it("excludes Xinhua video-only pages but keeps articles with substantial text", async () => {
    const xinhuaEndpoint: RouteDiscoveryEndpoint = {
      kind: "source-adapter",
      adapter: "xinhua",
      driver: "http",
      route: "taiwan",
      maximumItems: 20,
    };
    const xinhua: SourceConfig = {
      ...source,
      id: "xinhua",
      name: "新华网",
      language: "zh-CN",
      publicationTimeZone: "Asia/Shanghai",
      sections: [{ id: "taiwan", name: "台湾", url: "https://www.news.cn/tw/index.html" }],
      discovery: xinhuaEndpoint,
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/tw/index.html")) {
        return new Response([
          '<a href="/tw/20260826/video/c.html">Video</a>',
          '<a href="/tw/20260826/mixed/c.html">Mixed</a>',
        ].join(""), { status: 200 });
      }
      if (url.includes("/mixed/")) {
        return new Response(`
          <meta name="publishdate" content="2026-08-26 20:14:58">
          <h1>带视频的图文报道</h1>
          <div id="detailContent">
            <span class="pageVideo" video_src="https://vod.example.test/mixed.mp4"></span>
            <p>这是与视频共同发布的第一段实质正文，包含事件背景、现场情况以及相关人士的完整说明。</p>
            <p>这是第二段实质正文，继续补充报道细节，文本总量足以作为一篇独立的图文新闻阅读。</p>
            <p>新华社音视频部制作</p>
          </div>
        `, { status: 200 });
      }
      return new Response(`
        <meta name="publishdate" content="2026-08-26 20:13:58">
        <h1>新华社消息｜视频标题</h1>
        <div id="detailContent">
          <span class="pageVideo" video_src="https://vod.example.test/video.mp4"></span>
          <p>新华社音视频部制作</p>
        </div>
      `, { status: 200 });
    }));

    const result = await discoverXinhua(xinhua, xinhuaEndpoint, "2026-08-26T12:20:00Z");

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ title: "带视频的图文报道", contentStatus: "full" });
    expect(result.upstream).toMatchObject({ unsupportedMediaCount: 1 });
  });
});
