import { Blob as NodeBlob } from "node:buffer";
import { gzipSync } from "node:zlib";
import { transformJoxBytes } from "@jojo/content";
import { afterEach, describe, expect, it, vi } from "vitest";
import { timesApi } from "../src/times/api";

const indexObject = "content/timeline/index.jox";
const dayObject = "content/timeline/dates/2026/08/2026-08-22.jox";
const articleObject = "content/newspapers/example/articles/article-one.jox";
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
