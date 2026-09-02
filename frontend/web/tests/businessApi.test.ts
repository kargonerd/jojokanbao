import { Blob as NodeBlob } from "node:buffer";
import { gzipSync } from "node:zlib";
import { transformJoxBytes } from "@jojo/content";
import { afterEach, describe, expect, it, vi } from "vitest";
import { timesApi } from "../src/times/api";
import { presentTimesArticle } from "../src/times/language";

const indexObject = "content/timeline/index.jox";
const dayObject = "content/timeline/dates/2026/08/2026-08-22.jox";
const pageObject = "content/timeline/dates/2026/08/2026-08-22/page-0001.jox";
const articleObject = "content/newspapers/example/articles/article-one.jox";
const translatedArticleObject = "content/newspapers/example/articles/article-one-zh.jox";
const assetObject = "content/newspapers/example/assets/image-one.jox";
const item = {
  id: "article-one",
  title: "Headline",
  summary: "Summary",
  contentStatus: "full" as const,
  url: "https://publisher.example.test/story",
  publishedAt: "2026-08-22T10:00:00.000Z",
  issueDate: "2026-08-22",
  language: "en",
  source: { id: "example", name: "Example", language: "en" },
  articleObject,
  assets: [{
    id: "asset:image-one", type: "image" as const, role: "lead" as const,
    mediaType: "image/jpeg", object: assetObject, size: 11, sha256: "image-one",
  }],
};
const index = {
  formatVersion: "jojo-news-timeline-index/1",
  updatedAt: "2026-08-22T10:01:00.000Z",
  dates: [{ date: "2026-08-22", object: "dates/2026/08/2026-08-22.jox", articleCount: 1 }],
  sources: [item.source],
};
const day = {
  formatVersion: "jojo-news-timeline-day/1",
  date: "2026-08-22",
  updatedAt: "2026-08-22T10:01:00.000Z",
  articles: [item],
};

function joxResponse(objectKey: string, value: unknown): Response {
  const compressed = gzipSync(Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
  return new Response(transformJoxBytes(compressed, objectKey).slice().buffer);
}

function timelineFetch(includeArticle = false, articleAssetRefs = ["asset:image-one"]) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith(indexObject)) return joxResponse(indexObject, index);
    if (url.endsWith(dayObject)) return joxResponse(dayObject, day);
    if (includeArticle && url.endsWith(articleObject)) {
      return joxResponse(articleObject, {
        formatVersion: "jojo-fragment/1", itemId: "example:2026-08-22", fragmentId: "article-one",
        type: "article", order: 1, title: "Headline",
        body: { format: "html", profile: "jojo-semantic-html/1", value: "<p>Full body</p>" },
        assetRefs: articleAssetRefs, annotations: [],
      });
    }
    if (includeArticle && url.endsWith(assetObject)) {
      return new Response(transformJoxBytes(Buffer.from("image-bytes"), assetObject).slice().buffer);
    }
    return new Response("not found", { status: 404 });
  });
}

afterEach(() => {
  timesApi.invalidate();
  vi.unstubAllGlobals();
});

describe("Times B2 CDN client", () => {
  it("reads the global timeline index and requested day directly from the CDN", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    const fetchMock = timelineFetch();
    vi.stubGlobal("fetch", fetchMock);
    await expect(timesApi.timelineDay("2026-08-22")).resolves.toMatchObject({ articles: [item] });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`https://blacknews.jojokanbao.cn/${indexObject}`);
    expect(fetchMock.mock.calls[0]![1]).toEqual({ cache: "no-store" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads a small timeline page without downloading the full day", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    const pagedIndex = {
      ...index,
      dates: [{
        ...index.dates[0],
        pages: [{ object: "dates/2026/08/2026-08-22/page-0001.jox", articleCount: 1 }],
      }],
    };
    const page = {
      formatVersion: "jojo-news-timeline-page/1",
      date: "2026-08-22",
      page: 0,
      updatedAt: day.updatedAt,
      articles: [item],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(indexObject)) return joxResponse(indexObject, pagedIndex);
      if (url.endsWith(pageObject)) return joxResponse(pageObject, page);
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(timesApi.timelinePage("2026-08-22", 0)).resolves.toMatchObject({ articles: [item] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith(dayObject))).toBe(false);
  });

  it("loads immutable article content by issue date and article id", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    const NativeUrl = URL;
    const createObjectURL = vi.fn().mockReturnValue("blob:jojo-image-one");
    class TestUrl extends NativeUrl {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", TestUrl);
    const fetchMock = timelineFetch(true);
    vi.stubGlobal("fetch", fetchMock);
    await expect(timesApi.getNews("2026-08-22", "article-one")).resolves.toMatchObject({
      content: "<p>Full body</p>", contentFormat: "html",
      assetUrls: { "asset:image-one": "blob:jojo-image-one" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  it("uses the Simplified Chinese timeline metadata and translated fragment when available", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    const translatedItem = {
      ...item,
      assets: [],
      translations: {
        "zh-CN": {
          language: "zh-CN",
          title: "中文标题",
          summary: "中文摘要",
          articleObject: translatedArticleObject,
          provider: "google-gemini-api" as const,
          model: "gemma-4-31b-it",
        },
      },
    };
    const translatedDay = { ...day, articles: [translatedItem] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(indexObject)) return joxResponse(indexObject, index);
      if (url.endsWith(dayObject)) return joxResponse(dayObject, translatedDay);
      if (url.endsWith(translatedArticleObject)) return joxResponse(translatedArticleObject, {
        formatVersion: "jojo-fragment/1", itemId: "example:2026-08-22", fragmentId: "article-one",
        type: "article", order: 1, title: "中文标题",
        body: { format: "html", profile: "jojo-semantic-html/1", value: "<p>中文正文</p>" },
        assetRefs: [], annotations: [],
      });
      if (url.endsWith(articleObject)) return joxResponse(articleObject, {
        formatVersion: "jojo-fragment/1", itemId: "example:2026-08-22", fragmentId: "article-one",
        type: "article", order: 1, title: "Headline",
        body: { format: "html", profile: "jojo-semantic-html/1", value: "<p>Full body</p>" },
        assetRefs: [], annotations: [],
      });
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const timeline = await timesApi.timelineDay("2026-08-22");
    expect(timeline.articles[0]).toMatchObject({ title: "Headline", summary: "Summary", language: "en" });
    expect(presentTimesArticle(timeline.articles[0]!, "zh-CN")).toMatchObject({
      title: "中文标题", summary: "中文摘要", language: "zh-CN", usingTranslation: true,
    });
    await expect(timesApi.getNews("2026-08-22", "article-one")).resolves.toMatchObject({
      title: "中文标题", content: "<p>中文正文</p>", language: "zh-CN",
      translationAvailable: true, usingTranslation: true,
    });
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith(translatedArticleObject))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith(articleObject))).toBe(false);
    await expect(timesApi.getNews("2026-08-22", "article-one", "original")).resolves.toMatchObject({
      title: "Headline", summary: "Summary", content: "<p>Full body</p>", language: "en",
      translationAvailable: true, usingTranslation: false,
    });
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith(articleObject))).toBe(true);
  });

  it("falls back to the publisher-language fragment when a translated object is unavailable", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    const translatedDay = {
      ...day,
      articles: [{
        ...item,
        assets: [],
        translations: {
          "zh-CN": {
            language: "zh-CN", title: "中文标题", articleObject: translatedArticleObject,
            provider: "google-gemini-api" as const, model: "gemma-4-31b-it",
          },
        },
      }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(indexObject)) return joxResponse(indexObject, index);
      if (url.endsWith(dayObject)) return joxResponse(dayObject, translatedDay);
      if (url.endsWith(translatedArticleObject)) return new Response("not found", { status: 404 });
      if (url.endsWith(articleObject)) return joxResponse(articleObject, {
        formatVersion: "jojo-fragment/1", itemId: "example:2026-08-22", fragmentId: "article-one",
        type: "article", order: 1, title: "Headline",
        body: { format: "html", profile: "jojo-semantic-html/1", value: "<p>Full body</p>" },
        assetRefs: [], annotations: [],
      });
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(timesApi.getNews("2026-08-22", "article-one")).resolves.toMatchObject({
      title: "Headline", summary: null, content: "<p>Full body</p>", language: "en",
    });
  });

  it("does not render stale timeline images that the article object no longer references", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    const NativeUrl = URL;
    const createObjectURL = vi.fn().mockReturnValue("blob:stale-image");
    class TestUrl extends NativeUrl {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", TestUrl);
    const fetchMock = timelineFetch(true, []);
    vi.stubGlobal("fetch", fetchMock);

    await expect(timesApi.getNews("2026-08-22", "article-one")).resolves.toMatchObject({
      assets: [], assetUrls: {},
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("decodes an immutable image object for a timeline card", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    const NativeUrl = URL;
    const createObjectURL = vi.fn().mockReturnValue("blob:jojo-timeline-image");
    class TestUrl extends NativeUrl {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", TestUrl);
    const fetchMock = timelineFetch(true);
    vi.stubGlobal("fetch", fetchMock);

    await expect(timesApi.assetObjectUrl(item.assets[0]!)).resolves.toBe("blob:jojo-timeline-image");
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`https://blacknews.jojokanbao.cn/${assetObject}`);
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  it("rejects an HTML fallback instead of rendering an empty feed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<!doctype html>")));
    await expect(timesApi.timelineIndex()).rejects.toThrow();
  });
});
