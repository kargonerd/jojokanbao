import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverSource } from "../src/discovery/multi.js";
import {
  acceptSourceCandidate,
  processSourceCandidate,
  sourceBodyExtractor,
  sourceFetchPolicy,
  sourceImageExtractor,
  sourceUnavailablePageReason,
} from "../src/sources/registry.js";
import type { Candidate, DiscoveryEndpoint, SourceConfig } from "../src/types.js";

function source(id: string, discovery: DiscoveryEndpoint): SourceConfig {
  return {
    id,
    name: id,
    language: id === "cls" ? "zh-CN" : "en",
    publicationTimeZone: id === "cls" ? "Asia/Shanghai" : "UTC",
    discovery,
    content: {
      priority: ["captured-page", "discovery-summary"],
      ...(id === "xinhua" ? { minimumFullCharacters: 80, minimumFullParagraphs: 1 } : {}),
    },
    fetch: { strategy: "browser-first", bpc: true },
    health: { minimumCandidates: 1 },
    enabled: true,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("native source modules", () => {
  it("maps Nikkei's persisted GraphQL response and exposes its page policy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: { getLatestHeadlines: { items: [{
        remoteId: "nikkei-1",
        name: "Asia headline",
        displayDate: 1_787_650_000,
        path: "/business/technology/asia-headline",
        primaryTag: { name: "Technology" },
      }] } },
    }), { status: 200 })));
    const config = source("nikkei", {
      kind: "source-adapter", adapter: "nikkei", driver: "http", stream: "latest", maximumItems: 10,
    });

    const result = await discoverSource(config, "2026-08-25T00:00:00Z", 0);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toEqual(expect.objectContaining({
      canonicalUrl: "https://asia.nikkei.com/business/technology/asia-headline",
      publisherCategories: ["Technology"],
      upstreamId: "nikkei-1",
    }));
    expect(result.fetchPolicy?.bodySelectors[0]).toContain("NewsArticle");
  });

  it("signs and maps the CLS official depth API", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: {
      top_article: [{ id: 42, title: "市场新闻", brief: "市场新闻摘要", ctime: 1_787_650_000, author: "财联社", tags: [{ name: "原创" }] }],
      depth_list: [],
    } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = source("cls", {
      kind: "source-adapter", adapter: "cls", driver: "http", categoryId: "1000", maximumItems: 10,
    });

    const result = await discoverSource(config, "2026-08-25T00:00:00Z", 0);

    expect(result.candidates[0]).toEqual(expect.objectContaining({
      canonicalUrl: "https://www.cls.cn/detail/42",
      summary: "市场新闻摘要",
      authors: ["财联社"],
      publisherCategories: ["原创"],
    }));
    const requestedUrl = String((fetchMock.mock.calls as unknown as Array<[RequestInfo | URL]>)[0]?.[0]);
    expect(new URL(requestedUrl).searchParams.get("sign")).toMatch(/^[a-f0-9]{32}$/u);
    expect(result.fetchPolicy?.capture).toBe("browser");
  });

  it("falls back to the CLS website API host when its primary API host is unavailable", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {
        top_article: [{ id: 43, title: "备用接口新闻", ctime: 1_787_650_000 }],
        depth_list: [],
      } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = source("cls", {
      kind: "source-adapter", adapter: "cls", driver: "http", categoryId: "1000", maximumItems: 10,
    });

    const result = await discoverSource(config, "2026-08-25T00:00:00Z", 0);

    expect(result.candidates[0]?.title).toBe("备用接口新闻");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).hostname).toBe("api3.cls.cn");
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).hostname).toBe("www.cls.cn");
  });

  it("maps DW articles and liveblogs while omitting videos", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { content: {
      contentComposition: { informationSpaces: [{ main: [{ contents: [
        { id: 1, __typename: "Article", namedUrl: "/en/story/a-1", title: "Story", contentDate: "2026-08-25T10:00:00Z" },
        { id: 2, __typename: "Video", namedUrl: "/en/video/av-2", title: "Video", contentDate: "2026-08-25T10:00:00Z" },
      ] }] }] },
    } } }), { status: 200 })));
    const config = source("dw", {
      kind: "source-adapter", adapter: "dw", driver: "http", navigationId: "1432", maximumItems: 10,
    });

    const result = await discoverSource(config, "2026-08-25T00:00:00Z", 0);

    expect(result.candidates.map((candidate) => candidate.title)).toEqual(["Story"]);
    expect(result.fetchPolicy?.bodySelectors).toContain("main article");
  });

  it("runs a source process hook before Canonical without mutating the input", () => {
    const candidate = {
      publisherCategories: ["World", "World"],
    } as Candidate;
    const processed = processSourceCandidate("ap", candidate);
    expect(processed.publisherCategories).toEqual(["World"]);
    expect(candidate.publisherCategories).toEqual(["World", "World"]);
  });

  it("exposes Reuters direct paragraph blocks as a source page policy", () => {
    expect(sourceFetchPolicy("reuters")?.bodySelectors).toEqual([
      "[data-testid^='paragraph-'], [data-testid^='unordered-'] [data-testid='Body'], [data-testid='SignOff'] [data-testid='Body']",
    ]);
    expect(sourceFetchPolicy("reuters")?.captureUrl).toBe("source");
    expect(sourceBodyExtractor("reuters")).toBeTypeOf("function");
    expect(sourceImageExtractor("reuters")).toBeTypeOf("function");
    expect(sourceImageExtractor("ap")).toBeTypeOf("function");
    expect(sourceImageExtractor("cna")).toBeTypeOf("function");
    expect(sourceBodyExtractor("nyt")).toBeTypeOf("function");
    expect(sourceImageExtractor("nyt")).toBeTypeOf("function");
  });

  it("exposes Bloomberg's embedded article body strategy", () => {
    expect(sourceFetchPolicy("bloomberg")?.capture).toBe("browser");
    expect(sourceBodyExtractor("bloomberg")).toBeTypeOf("function");
  });

  it("exposes publisher-owned Next.js body extractors", () => {
    expect(sourceBodyExtractor("ap")).toBeTypeOf("function");
    expect(sourceBodyExtractor("thepaper")).toBeTypeOf("function");
    expect(sourceBodyExtractor("cls")).toBeTypeOf("function");
    expect(sourceBodyExtractor("chinanews")).toBeTypeOf("function");
    expect(sourceBodyExtractor("zaobao")).toBeTypeOf("function");
    expect(sourceImageExtractor("zaobao")).toBeTypeOf("function");
  });

  it("keeps publisher-owned selectors for changing article layouts", () => {
    expect(sourceFetchPolicy("cls")?.bodySelectors).toContain(".detail-content");
    expect(sourceFetchPolicy("chinanews")?.bodySelectors).toEqual([".left_zw", ".content_desc"]);
    expect(sourceFetchPolicy("focus-taiwan")?.bodySelectors).toContain(".paragraph");
    expect(sourceFetchPolicy("nikkei")?.bodySelectors).toContain("[class*='FeatureArticleBody_featureArticleBody']");
    expect(sourceFetchPolicy("people")?.bodySelectors).toContain("#rm_txt_zw");
  });

  it("keeps publisher-specific availability rules inside source modules", () => {
    const endpoint: DiscoveryEndpoint = { kind: "official-rss", url: "https://example.test/feed.xml" };
    const input = (overrides: Partial<Parameters<typeof sourceUnavailablePageReason>[1]> = {}) => ({
      title: "Article",
      url: "https://example.test/article",
      hasFullBody: false,
      ...overrides,
    });

    expect(sourceUnavailablePageReason(source("npr", endpoint), input({
      html: '<body class="no-transcript">',
    }))).toBe("UnsupportedMedia");
    expect(sourceUnavailablePageReason(source("npr", endpoint), input({
      hasFullBody: true,
      html: '<body class="no-transcript"><div id="storytext"><p>Original written report.</p></div></body>',
    }))).toBeUndefined();
    expect(sourceUnavailablePageReason(source("npr", endpoint), input({
      hasFullBody: true,
      html: '<body class="has-transcript"><div class="transcript storytext" aria-label="Transcript"><p>Host: Welcome.</p></div></body>',
    }))).toBe("UnsupportedMedia");
    expect(sourceUnavailablePageReason(source("npr", endpoint), input({
      hasFullBody: true,
      html: '<body><div id="storytext"><p>Original written report.</p></div></body>',
    }))).toBeUndefined();
    expect(sourceUnavailablePageReason(source("cls", endpoint), input({
      title: "航拍画面",
      html: "<video></video>",
    }))).toBe("UnsupportedMedia");
    expect(sourceUnavailablePageReason(source("xinhua", endpoint), input({
      html: '<div id="detailContent"><div class="pageVideo" video_src="movie.mp4"></div><p>新华社音视频部制作</p></div>',
    }))).toBe("UnsupportedMedia");
    expect(sourceUnavailablePageReason(source("nikkei", endpoint), input({
      html: '<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script><p>Preview</p>',
    }))).toBe("HardPaywall");
    expect(sourceUnavailablePageReason(source("scmp", endpoint), input({
      html: "SCMP Plus subscription is required for access.",
    }))).toBe("HardPaywall");
    expect(sourceUnavailablePageReason(source("nyt", endpoint), input({
      html: "You have a preview view of this article while we are checking your access. Subscribe for all of The Times.",
    }))).toBeUndefined();
  });

  it("keeps Xinhua image stories as image-led articles", () => {
    const extractor = sourceBodyExtractor("xinhua");
    expect(extractor?.(`<div id="detailContent">
      <div class="image"><img src="poster-1.jpg"></div>
      <div class="image"><img src="poster-2.jpg"></div>
      <p>文案：张晓洁</p><p>海报制作：贾稀荃、许涵毅</p><p>新华社国内部出品</p>
    </div>`, { minimumCharacters: 80, minimumParagraphs: 1 })).toBe(
      "<p>文案：张晓洁</p><p>海报制作：贾稀荃、许涵毅</p><p>新华社国内部出品</p>",
    );
    expect(extractor?.(`<div id="detailContent">
      <div class="image"><img src="lead.jpg"></div><p>这是包含完整正文的普通新闻。</p>
    </div>`, { minimumCharacters: 80, minimumParagraphs: 1 })).toBeUndefined();
    expect(extractor?.(`<div id="detailContent">
      <div class="image"><img src="lead.jpg"></div><p>记者调查发现当地居民生活已经恢复正常。</p>
    </div>`, { minimumCharacters: 80, minimumParagraphs: 1 })).toBeUndefined();
  });

  it("accepts a publisher-declared free Nikkei short article without lowering paywall thresholds", () => {
    const extractor = sourceBodyExtractor("nikkei");
    const paragraphs = [
      "China removed two senior military officers from their posts after investigations into suspected violations of discipline and law.",
      "The announcement concerned their positions in the state military commission and followed probes announced earlier in the year.",
      "The officers have not been publicly stripped of their parallel posts in the ruling party military commission.",
    ];
    const body = `<script type="application/ld+json">${JSON.stringify({
      "@type": "NewsArticle", isAccessibleForFree: true,
    })}</script><div class="ArticleBodyWithTracking_articleBodyWithTrackingTranslationWrapper"><div>
      ${paragraphs.map((value) => `<p>${value}</p>`).join("")}
    </div></div>`;
    expect(extractor?.(body, { minimumCharacters: 1_000, minimumParagraphs: 5 })).toContain(paragraphs[2]);
    expect(extractor?.(body.replace("true", "false"), {
      minimumCharacters: 1_000, minimumParagraphs: 5,
    })).toBeUndefined();
  });

  it("drops Focus Taiwan's homepage placeholder", () => {
    const candidate = {
      title: "Taiwan headline news",
      contentStatus: "summary",
    } as Candidate;
    expect(acceptSourceCandidate("focus-taiwan", candidate)).toBe(false);
  });

  it("keeps NYT live parents and excludes duplicate deep updates", () => {
    const candidate = (canonicalUrl: string): Candidate => ({
      articleId: "nyt:test",
      sourceId: "nyt",
      sourceName: "The New York Times",
      language: "en",
      sourceUrl: canonicalUrl,
      canonicalUrl,
      title: "NYT story",
      contentStatus: "summary",
      publishedAt: "2026-08-29T00:00:00.000Z",
      authors: [],
      publisherCategories: [],
    });
    const parent = candidate("https://www.nytimes.com/live/2026/08/28/world/nepal-tibet-flash-floods");
    const update = candidate("https://www.nytimes.com/live/2026/08/28/world/nepal-tibet-flash-floods/bharatpur-bodies-morgues");
    const article = candidate("https://www.nytimes.com/2026/08/28/world/asia/nepal-bodies-morgues.html");

    expect(acceptSourceCandidate("nyt", parent)).toBe(true);
    expect(acceptSourceCandidate("nyt", update)).toBe(false);
    expect(acceptSourceCandidate("nyt", article)).toBe(true);
    expect(processSourceCandidate("nyt", update)).toEqual(expect.objectContaining({ captureStatus: "duplicate" }));
  });
});
