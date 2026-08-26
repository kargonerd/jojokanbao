import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverHtmlListing } from "../src/discovery/html-listing.js";
import { discoverPeople } from "../src/sources/people/discover.js";
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
  sections: [{ id: "markets", name: "Markets", url: "https://example.test/world" }],
  discovery: endpoint,
  content: { priority: ["discovery-body", "discovery-summary"], minimumFullCharacters: 20, minimumFullParagraphs: 1 },
  archive: { mode: "browser", bpc: true },
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
});
