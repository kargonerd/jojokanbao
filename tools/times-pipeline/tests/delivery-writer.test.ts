import { gzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  gunzipJoxJson,
  transformJoxBytes,
  type JojoCatalog,
  type JojoFragment,
  type TimesDateManifest,
  type TimesSourceIndex,
  type TimesTimelineDay,
  type TimesTimelineIndex,
} from "@jojo/content";
import { describe, expect, it } from "vitest";
import type { CanonicalArticle, CanonicalWriteResult } from "../src/process/canonical-writer.js";
import { buildNewsDelivery } from "../src/delivery-writer.js";
import type { SourceConfig } from "../src/types.js";

const source: SourceConfig = {
  id: "example",
  name: "Example News",
  language: "en",
  publicationTimeZone: "UTC",
  discovery: { kind: "official-rss", url: "https://example.test/feed.xml" },
  content: { priority: ["discovery-body", "captured-page"] },
  fetch: { strategy: "direct-first", bpc: true },
  health: { minimumCandidates: 1 },
  enabled: true,
};

describe("news Delivery writer", () => {
  it("publishes immutable media objects, per-source indexes and a global timeline without virtual Times", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "jojo-news-delivery-workspace-"));
    const deliveryRoot = await mkdtemp(path.join(os.tmpdir(), "jojo-news-delivery-output-"));
    const imageObject = "raw/example/assets/image.jpg";
    await mkdir(path.dirname(path.join(workspaceRoot, ...imageObject.split("/"))), { recursive: true });
    await writeFile(path.join(workspaceRoot, ...imageObject.split("/")), Buffer.from("image-bytes"));
    const canonical: CanonicalArticle = {
      formatVersion: "jojo-news-article/2",
      articleId: "example:full",
      source: { id: source.id, name: source.name },
      canonicalUrl: "https://example.test/full",
      title: "Full story",
      authors: [],
      language: "en",
      publishedAt: "2026-08-23T09:30:00.000Z",
      publisherCategories: [],
      publisherSections: [{ id: "world", name: "World" }],
      categories: [],
      body: { format: "html", profile: "jojo-semantic-html/1", value: '<figure data-asset-id="asset:image"></figure><p>Full body</p>' },
      translations: {
        "zh-CN": {
          language: "zh-CN",
          title: "完整报道",
          body: { format: "html", profile: "jojo-semantic-html/1", value: '<figure data-asset-id="asset:image"></figure><p>完整正文</p>' },
          provider: "google-gemini-api",
          model: "gemma-4-31b-it",
          translatedAt: "2026-08-23T09:35:00.000Z",
          sourceHash: "source-hash",
        },
      },
      assets: [{
        id: "asset:image", type: "image", role: "lead", sourceUrl: "https://example.test/image.jpg",
        rawObject: imageObject, mediaType: "image/jpeg", size: 11, sha256: "image", alt: "Lead image",
      }],
      contentStatus: "full",
      contentHash: "full-hash",
      provenance: {
        rawRevision: "raw-revision", rawRunId: "run-1", rawManifest: "raw/example/manifest.json", discovery: source.discovery,
      },
    };
    const canonicalObject = "canonical/example/articles/full-hash.json.gz";
    await mkdir(path.dirname(path.join(workspaceRoot, ...canonicalObject.split("/"))), { recursive: true });
    await writeFile(path.join(workspaceRoot, ...canonicalObject.split("/")), gzipSync(`${JSON.stringify(canonical)}\n`));
    const processSource: CanonicalWriteResult = {
      sourceId: source.id,
      dates: ["2026-08-23"],
      articles: [{ articleId: canonical.articleId, object: canonicalObject, contentHash: canonical.contentHash, publishedAt: canonical.publishedAt }],
      files: [canonicalObject],
      skippedWithoutFullText: 0,
      unchangedWithoutRefresh: 0,
      unchangedArticles: [],
      skippedArticles: [],
    };
    const previousTimeline: TimesTimelineIndex = {
      formatVersion: "jojo-news-timeline-index/1",
      updatedAt: "2026-08-22T00:00:00Z",
      dates: [{ date: "2026-08-22", object: "dates/2026/08/2026-08-22.jox", articleCount: 1 }],
      sources: [],
    };
    const previousSource: TimesSourceIndex = {
      formatVersion: "jojo-delivery-index/1", revision: 1, datasetId: "news-example", type: "newspaper",
      title: source.name, language: source.language, source: { id: source.id, name: source.name, language: source.language },
      items: [{ itemId: "example:2026-08-22", itemKey: "2026-08-22", type: "newspaper", order: 1, title: "Previous", manifestObject: "dates/2026/08/2026-08-22.jox" }],
      updatedAt: "2026-08-22T00:00:00Z",
    };
    const previousCatalog: JojoCatalog = {
      formatVersion: "jojo-catalog/1", revision: 1, updatedAt: "2026-08-22T00:00:00Z",
      datasets: [
        {
          datasetId: "reader", type: "book", title: "Reader", language: "zh-CN", itemCount: 1,
          indexObject: "content/books/reader/index.jox", aiEnabled: true, publicationStatus: "published", access: "public",
        },
        {
          datasetId: "times", type: "newspaper", title: "Old Times", language: "mul", itemCount: 1,
          indexObject: "content/newspapers/times/index.jox", aiEnabled: false, publicationStatus: "published", access: "authenticated",
        },
      ],
    };
    const result = await buildNewsDelivery({
      workspaceRoot,
      deliveryRoot,
      generatedAt: "2026-08-23T10:00:00.000Z",
      sources: [source],
      process: { sources: [processSource] },
      previousTimelineIndex: previousTimeline,
      previousSourceIndexes: new Map([[source.id, previousSource]]),
      previousCatalog,
    });

    expect(result.timelineIndexObject).toBe("content/timeline/index.jox");
    const index = await gunzipJoxJson<TimesTimelineIndex>(
      new Uint8Array(await readFile(path.join(deliveryRoot, "content/timeline/index.jox"))),
      "content/timeline/index.jox",
    );
    expect(index.dates.map((date) => date.date)).toEqual(["2026-08-23", "2026-08-22"]);
    const dayObject = "content/timeline/dates/2026/08/2026-08-23.jox";
    const day = await gunzipJoxJson<TimesTimelineDay>(new Uint8Array(await readFile(path.join(deliveryRoot, ...dayObject.split("/")))), dayObject);
    expect(day.articles[0]).toMatchObject({ id: "example:full", source: { id: "example" }, assets: [{ id: "asset:image" }] });
    expect(day.articles[0]!.articleObject).toMatch(/^content\/newspapers\/example\/articles\/[a-f0-9]+\.jox$/u);
    expect(day.articles[0]!.translations?.["zh-CN"]).toMatchObject({
      language: "zh-CN",
      title: "完整报道",
      summary: "完整正文",
      model: "gemma-4-31b-it",
    });

    const sourceIndexObject = "content/newspapers/example/index.jox";
    const sourceIndex = await gunzipJoxJson<TimesSourceIndex>(new Uint8Array(await readFile(path.join(deliveryRoot, ...sourceIndexObject.split("/")))), sourceIndexObject);
    expect(sourceIndex.items.map((item) => item.itemKey)).toEqual(["2026-08-23", "2026-08-22"]);
    const manifestObject = "content/newspapers/example/dates/2026/08/2026-08-23.jox";
    const manifest = await gunzipJoxJson<TimesDateManifest>(new Uint8Array(await readFile(path.join(deliveryRoot, ...manifestObject.split("/")))), manifestObject);
    expect(manifest.assets).toHaveLength(1);
    const fragmentObject = day.articles[0]!.articleObject;
    const fragment = await gunzipJoxJson<JojoFragment>(new Uint8Array(await readFile(path.join(deliveryRoot, ...fragmentObject.split("/")))), fragmentObject);
    expect(fragment.assetRefs).toEqual(["asset:image"]);
    expect(fragment.title).toBe("Full story");
    const translatedObject = day.articles[0]!.translations!["zh-CN"]!.articleObject;
    const translatedFragment = await gunzipJoxJson<JojoFragment>(
      new Uint8Array(await readFile(path.join(deliveryRoot, ...translatedObject.split("/")))),
      translatedObject,
    );
    expect(translatedFragment).toMatchObject({ title: "完整报道", body: { value: '<figure data-asset-id="asset:image"></figure><p>完整正文</p>' } });
    const assetObject = day.articles[0]!.assets[0]!.object;
    expect(Buffer.from(transformJoxBytes(new Uint8Array(await readFile(path.join(deliveryRoot, ...assetObject.split("/")))), assetObject)).toString()).toBe("image-bytes");
    const catalog = await gunzipJoxJson<JojoCatalog>(new Uint8Array(await readFile(path.join(deliveryRoot, "catalog.jox"))), "catalog.jox");
    expect(catalog.datasets.map((dataset) => dataset.datasetId)).toEqual(["reader", "news-example"]);
    expect(catalog.datasets.find((dataset) => dataset.datasetId === "reader")?.aiEnabled).toBe(true);
    expect(catalog.datasets.find((dataset) => dataset.datasetId === "news-example")?.aiEnabled).toBe(false);
    expect(sourceIndex.aiEnabled).toBe(false);
    await expect(readFile(path.join(deliveryRoot, "content/newspapers/times/index.jox"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes newly classified unsupported media from mutable Delivery indexes", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "jojo-news-removal-workspace-"));
    const deliveryRoot = await mkdtemp(path.join(os.tmpdir(), "jojo-news-removal-output-"));
    const date = "2026-08-23";
    const removedId = "example:transcript";
    const keptId = "example:written";
    const article = (id: string, title: string) => ({
      id,
      title,
      contentStatus: "full" as const,
      url: `https://example.test/${id}`,
      publishedAt: "2026-08-23T09:30:00.000Z",
      issueDate: date,
      language: "en",
      source: { id: source.id, name: source.name, language: source.language },
      articleObject: `content/newspapers/example/articles/${id}.jox`,
      assets: [],
    });
    const previousDay: TimesTimelineDay = {
      formatVersion: "jojo-news-timeline-day/1",
      date,
      updatedAt: "2026-08-23T09:00:00.000Z",
      articles: [article(removedId, "Audio transcript"), article(keptId, "Written report")],
    };
    const previousTimeline: TimesTimelineIndex = {
      formatVersion: "jojo-news-timeline-index/1",
      updatedAt: previousDay.updatedAt,
      dates: [{ date, object: "dates/2026/08/2026-08-23.jox", articleCount: 2 }],
      sources: [{ id: source.id, name: source.name, language: source.language }],
    };
    const previousSource: TimesSourceIndex = {
      formatVersion: "jojo-delivery-index/1",
      revision: 1,
      datasetId: "news-example",
      type: "newspaper",
      title: source.name,
      language: source.language,
      source: { id: source.id, name: source.name, language: source.language },
      items: [{
        itemId: `example:${date}`,
        itemKey: date,
        type: "newspaper",
        order: 1,
        title: `Example News · ${date}`,
        manifestObject: "dates/2026/08/2026-08-23.jox",
      }],
      updatedAt: previousDay.updatedAt,
    };
    const processSource: CanonicalWriteResult = {
      sourceId: source.id,
      dates: [date],
      articles: [],
      files: [],
      skippedWithoutFullText: 1,
      unchangedWithoutRefresh: 0,
      unchangedArticles: [],
      skippedArticles: [{
        articleId: removedId,
        title: "Audio transcript",
        canonicalUrl: "https://example.test/transcript",
        publishedAt: "2026-08-23T09:30:00.000Z",
        reason: "unsupported-media",
        contentStatus: "summary",
        captureStatus: "skipped",
      }],
    };

    await buildNewsDelivery({
      workspaceRoot,
      deliveryRoot,
      generatedAt: "2026-08-23T10:00:00.000Z",
      sources: [source],
      process: { sources: [processSource] },
      previousTimelineIndex: previousTimeline,
      previousTimelineDays: new Map([[date, previousDay]]),
      previousSourceIndexes: new Map([[source.id, previousSource]]),
    });

    const dayObject = "content/timeline/dates/2026/08/2026-08-23.jox";
    const day = await gunzipJoxJson<TimesTimelineDay>(
      new Uint8Array(await readFile(path.join(deliveryRoot, ...dayObject.split("/")))),
      dayObject,
    );
    expect(day.articles.map((row) => row.id)).toEqual([keptId]);
    const manifestObject = "content/newspapers/example/dates/2026/08/2026-08-23.jox";
    const manifest = await gunzipJoxJson<TimesDateManifest>(
      new Uint8Array(await readFile(path.join(deliveryRoot, ...manifestObject.split("/")))),
      manifestObject,
    );
    expect(manifest.metadata.articles.map((row) => row.id)).toEqual([keptId]);
  });

  it("removes NYT live deep updates and moves a refreshed live parent to its new date", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "jojo-news-nyt-live-workspace-"));
    const deliveryRoot = await mkdtemp(path.join(os.tmpdir(), "jojo-news-nyt-live-output-"));
    const nyt: SourceConfig = {
      ...source,
      id: "nyt",
      name: "The New York Times",
      discovery: { kind: "official-rss", url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml" },
    };
    const oldDate = "2026-08-28";
    const newDate = "2026-08-29";
    const liveId = "nyt:live-parent";
    const liveUrl = "https://www.nytimes.com/live/2026/08/28/world/nepal-tibet-flash-floods";
    const previousArticle = (id: string, url: string, title: string) => ({
      id,
      title,
      contentStatus: "full" as const,
      url,
      publishedAt: `${oldDate}T22:53:12.000Z`,
      issueDate: oldDate,
      language: "en",
      source: { id: nyt.id, name: nyt.name, language: nyt.language },
      articleObject: `content/newspapers/nyt/articles/${id}.jox`,
      assets: [],
    });
    const previousDay: TimesTimelineDay = {
      formatVersion: "jojo-news-timeline-day/1",
      date: oldDate,
      updatedAt: `${oldDate}T23:00:00.000Z`,
      articles: [
        previousArticle(liveId, liveUrl, "Live Updates"),
        previousArticle("nyt:deep-update", `${liveUrl}/bharatpur-bodies-morgues`, "A Nepali city struggles"),
      ],
    };
    const canonical: CanonicalArticle = {
      formatVersion: "jojo-news-article/2",
      articleId: liveId,
      source: { id: nyt.id, name: nyt.name },
      canonicalUrl: liveUrl,
      title: "Updated live coverage",
      authors: [],
      language: "en",
      publishedAt: `${newDate}T09:25:20.000Z`,
      publisherCategories: [],
      publisherSections: [{ id: "world", name: "World" }],
      categories: [],
      body: { format: "html", profile: "jojo-semantic-html/1", value: "<p>Updated live body.</p>" },
      assets: [],
      contentStatus: "full",
      contentHash: "nyt-live-hash",
      provenance: {
        rawRevision: "raw-revision",
        rawRunId: "run-nyt-live",
        rawManifest: "raw/nyt/manifest.json",
        discovery: nyt.discovery,
      },
    };
    const canonicalObject = "canonical/nyt/articles/nyt-live-hash.json.gz";
    await mkdir(path.dirname(path.join(workspaceRoot, ...canonicalObject.split("/"))), { recursive: true });
    await writeFile(path.join(workspaceRoot, ...canonicalObject.split("/")), gzipSync(`${JSON.stringify(canonical)}\n`));
    const processSource: CanonicalWriteResult = {
      sourceId: nyt.id,
      dates: [newDate],
      articles: [{ articleId: liveId, object: canonicalObject, contentHash: canonical.contentHash, publishedAt: canonical.publishedAt }],
      files: [canonicalObject],
      skippedWithoutFullText: 0,
      unchangedWithoutRefresh: 0,
      unchangedArticles: [],
      skippedArticles: [],
    };
    const previousTimeline: TimesTimelineIndex = {
      formatVersion: "jojo-news-timeline-index/1",
      updatedAt: previousDay.updatedAt,
      dates: [{ date: oldDate, object: `dates/2026/08/${oldDate}.jox`, articleCount: 2 }],
      sources: [{ id: nyt.id, name: nyt.name, language: nyt.language }],
    };
    const previousSource: TimesSourceIndex = {
      formatVersion: "jojo-delivery-index/1",
      revision: 1,
      datasetId: "news-nyt",
      type: "newspaper",
      title: nyt.name,
      language: nyt.language,
      source: { id: nyt.id, name: nyt.name, language: nyt.language },
      items: [{
        itemId: `nyt:${oldDate}`,
        itemKey: oldDate,
        type: "newspaper",
        order: 1,
        title: `${nyt.name} · ${oldDate}`,
        manifestObject: `dates/2026/08/${oldDate}.jox`,
      }],
      updatedAt: previousDay.updatedAt,
    };

    await buildNewsDelivery({
      workspaceRoot,
      deliveryRoot,
      generatedAt: `${newDate}T10:00:00.000Z`,
      sources: [nyt],
      process: { sources: [processSource] },
      previousTimelineIndex: previousTimeline,
      previousTimelineDays: new Map([[oldDate, previousDay]]),
      previousSourceIndexes: new Map([[nyt.id, previousSource]]),
    });

    const oldDayObject = `content/timeline/dates/2026/08/${oldDate}.jox`;
    const oldDay = await gunzipJoxJson<TimesTimelineDay>(
      new Uint8Array(await readFile(path.join(deliveryRoot, ...oldDayObject.split("/")))),
      oldDayObject,
    );
    expect(oldDay.articles).toEqual([]);
    const newDayObject = `content/timeline/dates/2026/08/${newDate}.jox`;
    const newDay = await gunzipJoxJson<TimesTimelineDay>(
      new Uint8Array(await readFile(path.join(deliveryRoot, ...newDayObject.split("/")))),
      newDayObject,
    );
    expect(newDay.articles).toEqual([expect.objectContaining({ id: liveId, title: "Updated live coverage" })]);
    const indexObject = "content/timeline/index.jox";
    const index = await gunzipJoxJson<TimesTimelineIndex>(
      new Uint8Array(await readFile(path.join(deliveryRoot, ...indexObject.split("/")))),
      indexObject,
    );
    expect(index.dates.map((date) => date.date)).toEqual([newDate]);
    const sourceIndexObject = "content/newspapers/nyt/index.jox";
    const sourceIndex = await gunzipJoxJson<TimesSourceIndex>(
      new Uint8Array(await readFile(path.join(deliveryRoot, ...sourceIndexObject.split("/")))),
      sourceIndexObject,
    );
    expect(sourceIndex.items.map((item) => item.itemKey)).toEqual([newDate]);
  });
});
