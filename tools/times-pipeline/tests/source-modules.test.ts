import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverSource } from "../src/discovery/multi.js";
import { processSourceCandidate, sourcePagePolicy } from "../src/sources/registry.js";
import type { Candidate, DiscoveryEndpoint, SourceConfig } from "../src/types.js";

function source(id: string, discovery: DiscoveryEndpoint): SourceConfig {
  return {
    id,
    name: id,
    language: id === "cls" ? "zh-CN" : "en",
    discovery,
    content: { priority: ["browser-parser", "discovery-summary"] },
    archive: { mode: "browser", bpc: true },
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
    expect(result.pagePolicy?.bodySelectors[0]).toContain("NewsArticle");
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
    expect(result.pagePolicy?.capture).toBe("browser");
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
    expect(result.pagePolicy?.bodySelectors).toContain("main article");
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
    expect(sourcePagePolicy("reuters")?.bodySelectors).toEqual([
      "[data-testid^='paragraph-'], [data-testid^='unordered-'] [data-testid='Body'], [data-testid='SignOff'] [data-testid='Body']",
    ]);
    expect(sourcePagePolicy("reuters")?.captureUrl).toBe("source");
  });

  it("exposes Bloomberg's embedded article body strategy", () => {
    expect(sourcePagePolicy("bloomberg-markets")).toEqual(expect.objectContaining({
      bodyExtractor: "bloomberg-next-data",
      capture: "browser",
    }));
  });
});
