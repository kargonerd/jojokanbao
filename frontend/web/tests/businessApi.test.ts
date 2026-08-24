import { Blob as NodeBlob } from "node:buffer";
import { gzipSync } from "node:zlib";
import { NEWS_TIMELINE_PROFILE, transformJoxBytes } from "@jojo/content";
import { afterEach, describe, expect, it, vi } from "vitest";

import { timesApi } from "../src/times/api";

const catalogObject = "catalog.jox";
const indexObject = "content/newspapers/example/index.jox";
const manifestObject = "content/newspapers/example/items/2026/08/2026-08-22/manifest.jox";
const articleObject = "content/newspapers/example/items/2026/08/2026-08-22/articles/article-one.jox";
const item = {
  id: "example:article-one",
  title: "Headline",
  summary: "Summary",
  url: "https://publisher.example.test/story",
  publishedAt: "2026-08-22T10:00:00.000Z",
  issueDate: "2026-08-22",
  language: "en",
  source: { id: "example", name: "Example", language: "en" },
  authors: ["Reporter"],
  categories: ["world"],
  publisherCategories: ["World"],
  articleObject,
};

const catalog = {
  formatVersion: "jojo-catalog/1",
  revision: 1,
  updatedAt: "2026-08-22T10:01:00.000Z",
  datasets: [{
    datasetId: "example",
    type: "newspaper",
    title: "Example",
    language: "en",
    contentProfile: NEWS_TIMELINE_PROFILE,
    indexObject,
  }, {
    datasetId: "rmrb",
    type: "newspaper",
    title: "人民日报",
    language: "zh-CN",
    indexObject: "content/newspapers/rmrb/index.jox",
  }],
};

const index = {
  formatVersion: "jojo-delivery-index/1",
  revision: 1,
  updatedAt: "2026-08-22T10:01:00.000Z",
  datasetId: "example",
  type: "newspaper",
  title: "Example",
  language: "en",
  contentProfile: NEWS_TIMELINE_PROFILE,
  items: [{
    itemId: "example:2026-08-22",
    itemKey: "2026-08-22",
    type: "newspaper",
    order: 1,
    title: "Example · 2026-08-22",
    manifestObject: "items/2026/08/2026-08-22/manifest.jox",
  }],
};

const manifest = {
  formatVersion: "jojo-item-manifest/1",
  revision: 1,
  itemId: "example:2026-08-22",
  datasetId: "example",
  type: "newspaper",
  title: "Example · 2026-08-22",
  language: "en",
  metadata: {
    formatVersion: "jojo-news-date-metadata/1",
    issueDate: "2026-08-22",
    generatedAt: "2026-08-22T10:01:00.000Z",
    source: item.source,
    articles: [item],
  },
  content: { schema: "jojo-content/newspaper/1", articles: [] },
  contentStats: { articleCount: 1, characterCount: 7 },
  assets: [],
  exports: [],
};

function joxResponse(objectKey: string, value: unknown): Response {
  const compressed = gzipSync(Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
  const protectedBytes = transformJoxBytes(compressed, objectKey);
  return new Response(protectedBytes.slice().buffer);
}

function newsFetch(includeArticle = false) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith(catalogObject)) return joxResponse(catalogObject, catalog);
    if (url.endsWith(indexObject)) return joxResponse(indexObject, index);
    if (url.endsWith(manifestObject)) return joxResponse(manifestObject, manifest);
    if (includeArticle && url.endsWith(articleObject)) {
      return joxResponse(articleObject, {
        formatVersion: "jojo-fragment/1",
        itemId: "example:2026-08-22",
        fragmentId: "example:article-one",
        type: "article",
        order: 1,
        title: "Headline",
        body: { format: "text", value: "Full article" },
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

describe("news timeline B2 CDN client", () => {
  it("discovers timeline publishers from the catalog and loads a date across their manifests", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    const fetchMock = newsFetch();
    vi.stubGlobal("fetch", fetchMock);

    await expect(timesApi.listNews()).resolves.toEqual([item]);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://blacknews.jojokanbao.cn/catalog.jox");
    expect(fetchMock.mock.calls[0]![1]).toEqual({ cache: "no-store" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("loads a historical article directly from its publisher and issue date", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    const fetchMock = newsFetch(true);
    vi.stubGlobal("fetch", fetchMock);

    await expect(timesApi.getNews("example", "2026-08-22", "example:article-one"))
      .resolves.toMatchObject({ content: "Full article", contentFormat: "text" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not mistake an unrelated newspaper dataset for a live-news publisher", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    const fetchMock = newsFetch();
    vi.stubGlobal("fetch", fetchMock);

    await expect(timesApi.directory()).resolves.toMatchObject({
      publishers: [{ id: "example" }],
      dates: ["2026-08-22"],
    });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/rmrb/"))).toBe(false);
  });
});
