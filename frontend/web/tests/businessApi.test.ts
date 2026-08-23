import { Blob as NodeBlob } from "node:buffer";
import { gzipSync } from "node:zlib";
import { transformJoxBytes } from "@jojo/content";
import { afterEach, describe, expect, it, vi } from "vitest";

import { timesApi } from "../src/times/api";

const indexObject = "content/newspapers/times/index.jox";
const manifestObject = "content/newspapers/times/items/2026/08/2026-08-22/manifest.jox";
const articleObject = "content/newspapers/times/items/2026/08/2026-08-22/articles/article-one.jox";
const item = {
  id: "article-one",
  title: "Headline",
  summary: "Summary",
  contentStatus: "summary" as const,
  url: "https://publisher.example.test/story",
  publishedAt: "2026-08-22T10:00:00.000Z",
  issueDate: "2026-08-22",
  language: "en",
  source: { id: "example", name: "Example", language: "en" },
  articleObject,
};

const index = {
  formatVersion: "jojo-delivery-index/1",
  revision: 1,
  updatedAt: "2026-08-22T10:01:00.000Z",
  datasetId: "times",
  type: "newspaper",
  title: "JOJO 时事",
  language: "mul",
  items: [{
    itemId: "times:2026-08-22",
    itemKey: "2026-08-22",
    type: "newspaper",
    order: 1,
    title: "时事 · 2026-08-22",
    manifestObject: "items/2026/08/2026-08-22/manifest.jox",
  }],
  window: { from: "2026-08-21T10:01:00.000Z", to: "2026-08-22T10:01:00.000Z", hours: 24 },
  sourceHealth: [{
    source: item.source,
    status: "degraded",
    discovered: 1,
    delivered: 1,
    full: 0,
    summary: 1,
    unavailable: 0,
    availabilityRate: 1,
    fullTextRate: 0,
    healthScore: 50,
    networkExchanges: 1,
    browserAttempts: 0,
    browserSucceeded: 0,
    browserFailed: 0,
    updatedAt: "2026-08-22T10:01:00.000Z",
  }],
  unavailableCases: [],
};

const manifest = {
  formatVersion: "jojo-item-manifest/1",
  revision: 1,
  itemId: "times:2026-08-22",
  datasetId: "times",
  type: "newspaper",
  title: "时事 · 2026-08-22",
  language: "mul",
  metadata: {
    formatVersion: "jojo-times-date-metadata/1",
    issueDate: "2026-08-22",
    generatedAt: "2026-08-22T10:01:00.000Z",
    articles: [item],
  },
  content: { schema: "jojo-content/newspaper/1", articles: [] },
  contentStats: { chapterCount: 1, characterCount: 7 },
  assets: [],
  exports: [],
};

function joxResponse(objectKey: string, value: unknown): Response {
  const compressed = gzipSync(Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
  const protectedBytes = transformJoxBytes(compressed, objectKey);
  return new Response(protectedBytes.slice().buffer);
}

function indexFetch(includeArticle = false) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith(indexObject)) return joxResponse(indexObject, index);
    if (url.endsWith(manifestObject)) return joxResponse(manifestObject, manifest);
    if (includeArticle && url.endsWith(articleObject)) {
      return joxResponse(articleObject, {
        formatVersion: "jojo-fragment/1",
        itemId: "times:2026-08-22",
        fragmentId: "article-one",
        type: "article",
        order: 1,
        title: "Headline",
        body: { format: "text", value: "Summary" },
        assetRefs: [],
        annotations: [],
      });
    }
    return new Response("not found", { status: 404 });
  });
}

afterEach(() => {
  timesApi.invalidate();
  vi.unstubAllGlobals();
});

describe("Times B2 CDN client", () => {
  it("reads index and date manifest directly from the content CDN", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    const fetchMock = indexFetch();
    vi.stubGlobal("fetch", fetchMock);

    await expect(timesApi.listNews()).resolves.toEqual([item]);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`https://blacknews.jojokanbao.cn/${indexObject}`);
    expect(fetchMock.mock.calls[0]![1]).toEqual({ cache: "no-store" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("loads article content from the immutable article Jox object", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    const fetchMock = indexFetch(true);
    vi.stubGlobal("fetch", fetchMock);

    await expect(timesApi.getNews("article-one")).resolves.toMatchObject({ content: "Summary", contentFormat: "text" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects an HTML fallback instead of rendering an empty feed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<!doctype html>")));

    await expect(timesApi.listNews()).rejects.toThrow();
  });
});
