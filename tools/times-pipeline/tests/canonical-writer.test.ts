import { gunzipSync } from "node:zlib";
import { mkdtemp, readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeCanonicalSource, type CanonicalArticle } from "../src/process/canonical-writer.js";
import type { ProcessedCandidate } from "../src/process/article.js";
import { removeParserArtifacts } from "../src/text.js";
import type { SourceCaptureManifest, SourceConfig } from "../src/types.js";

const source: SourceConfig = {
  id: "reuters",
  name: "Reuters",
  language: "en",
  publicationTimeZone: "UTC",
  discovery: {
    kind: "sitemap",
    url: "https://www.reuters.com/arc/outboundfeeds/sitemap-index/?outputType=xml",
    maximumPages: 20,
  },
  content: { priority: ["captured-page", "discovery-summary"], parser: "reuters" },
  fetch: { strategy: "browser-first", bpc: true },
  health: { minimumCandidates: 1 },
  enabled: true,
};

describe("canonical writer", () => {
  it("removes upstream parser component placeholders from publishable content", () => {
    expect(removeParserArtifacts('<p>Before</p>Unhandled type: inline-plus-widget {"type":"inline-plus-widget"}<p>After</p>'))
      .toBe("<p>Before</p> <p>After</p>");
  });

  it("writes immutable text and image-only articles plus a per-source date index", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-times-canonical-"));
    const manifest: SourceCaptureManifest = {
      formatVersion: "jojo-times-raw-source-run/2",
      runId: "run-1",
      sourceId: "reuters",
      sourceName: "Reuters",
      publicationTimeZone: "UTC",
      startedAt: "2026-08-23T10:00:00Z",
      completedAt: "2026-08-23T10:01:00Z",
      discovery: source.discovery,
      candidateCount: 1,
      fullCount: 1,
      summaryCount: 1,
      metadataCount: 0,
      networkExchangeCount: 1,
      objects: [],
      captureStatus: "discovery-complete",
      healthStatus: "healthy",
      complete: true,
    };
    const candidate: ProcessedCandidate = {
      articleId: "reuters:one",
      sourceId: "reuters",
      sourceName: "Reuters",
      language: "en",
      sourceUrl: "https://www.reuters.com/world/one",
      canonicalUrl: "https://www.reuters.com/world/one",
      title: "One",
      summary: "Summary",
      processedBody: '<figure data-asset-id="asset:image"></figure><p>Complete Reuters article body.</p>',
      contentStatus: "full",
      assets: [{
        id: "asset:image",
        type: "image",
        role: "lead",
        sourceUrl: "https://example.test/image.jpg",
        rawObject: "raw/reuters/assets/image.jpg",
        mediaType: "image/jpeg",
        size: 10,
        sha256: "image",
      }],
      publishedAt: "2026-08-23T10:00:00Z",
      authors: [],
      publisherCategories: ["World"],
      publisherSections: [{ id: "world", name: "World" }],
    };
    const imageOnly = {
      ...candidate,
      articleId: "reuters:image-only",
      title: "Image-only report",
      processedBody: '<figure data-publisher-image-only="true"></figure><figure data-asset-id="asset:image"></figure>',
    };
    const translatedCandidate: ProcessedCandidate = {
      ...candidate,
      translation: {
        language: "zh-CN",
        title: "第一篇报道",
        body: { format: "html", profile: "jojo-semantic-html/1", value: '<figure data-asset-id="asset:image"></figure><p>路透社完整报道正文。</p>' },
        provider: "google-gemini-api",
        model: "gemma-4-31b-it",
        translatedAt: "2026-08-23T10:02:00Z",
        sourceHash: "source-hash",
      },
      translationCacheObject: "canonical/reuters/translations/gemma-news-zh-v2/2026/08/2026-08-23/cache.json.gz",
      translationStatus: "translated",
    };
    const result = await writeCanonicalSource(output, source, manifest, "raw/reuters/runs/run/manifest.json", [
      translatedCandidate, imageOnly,
      { ...candidate, articleId: "reuters:summary", processedBody: "", assets: [], contentStatus: "summary" },
      { ...candidate, articleId: "reuters:unchanged", processedBody: "", assets: [], contentStatus: "summary", captureStatus: "unchanged" },
    ], "raw-sha");
    expect(result.articles).toHaveLength(2);
    expect(result.skippedWithoutFullText).toBe(1);
    expect(result.skippedArticles).toEqual([
      expect.objectContaining({
        articleId: "reuters:summary",
        reason: "full-text-missing",
        contentStatus: "summary",
      }),
    ]);
    expect(result.unchangedWithoutRefresh).toBe(1);
    expect(result.unchangedArticles).toEqual([
      expect.objectContaining({
        articleId: "reuters:unchanged",
        captureStatus: "unchanged",
      }),
    ]);
    const articleFile = path.join(output, ...result.articles[0]!.object.split("/"));
    const row = JSON.parse(gunzipSync(await readFile(articleFile)).toString("utf8")) as Record<string, unknown>;
    expect(row).toMatchObject({
      articleId: "reuters:one",
      contentStatus: "full",
      publisherSections: [{ id: "world", name: "World" }],
      assets: [{ id: "asset:image", rawObject: "raw/reuters/assets/image.jpg" }],
      translations: {
        "zh-CN": {
          title: "第一篇报道",
          model: "gemma-4-31b-it",
          body: { value: '<figure data-asset-id="asset:image"></figure><p>路透社完整报道正文。</p>' },
        },
      },
    });
    expect(result.files).toContain(translatedCandidate.translationCacheObject);
    const failedRefresh = await writeCanonicalSource(output, source, manifest, "raw/reuters/runs/run/manifest.json", [{
      ...candidate,
      processedBody: '<figure data-asset-id="asset:image"></figure><p>Updated Reuters article body.</p>',
      previousTranslations: { "zh-CN": translatedCandidate.translation! },
      translationStatus: "failed",
      translationError: "temporary model failure",
    }], "raw-sha-refresh");
    const failedRefreshRow = JSON.parse(gunzipSync(await readFile(path.join(
      output, ...failedRefresh.articles[0]!.object.split("/"),
    ))).toString("utf8")) as CanonicalArticle;
    expect(failedRefreshRow.body.value).toContain("Updated Reuters article body");
    expect(failedRefreshRow.translations?.["zh-CN"]).toMatchObject({
      title: "第一篇报道",
      stale: true,
    });
    const imageOnlyRef = result.articles.find((article) => article.articleId === "reuters:image-only");
    const imageOnlyRow = JSON.parse(gunzipSync(await readFile(path.join(
      output, ...imageOnlyRef!.object.split("/"),
    ))).toString("utf8")) as { body: { value: string } };
    expect(imageOnlyRow.body.value).toBe('<figure data-asset-id="asset:image"></figure>');
    const date = JSON.parse(gunzipSync(await readFile(path.join(
      output, "canonical", "reuters", "dates", "2026", "08", "2026-08-23.json.gz",
    ))).toString("utf8")) as { articles: Array<{ articleId: string }> };
    expect(date.articles.map((article) => article.articleId).toSorted()).toEqual(["reuters:image-only", "reuters:one"]);

    const removal = await writeCanonicalSource(output, source, manifest, "raw/reuters/runs/run/manifest.json", [{
      ...candidate,
      processedBody: "",
      contentStatus: "summary",
      captureStatus: "skipped",
    }], "raw-sha-2");
    expect(removal.dates).toEqual(["2026-08-23"]);
    expect(removal.skippedArticles).toEqual([
      expect.objectContaining({ articleId: "reuters:one", reason: "unsupported-media" }),
    ]);
    const dateAfterRemoval = JSON.parse(gunzipSync(await readFile(path.join(
      output, "canonical", "reuters", "dates", "2026", "08", "2026-08-23.json.gz",
    ))).toString("utf8")) as { articles: Array<{ articleId: string }> };
    expect(dateAfterRemoval.articles.map((article) => article.articleId)).toEqual(["reuters:image-only"]);

    const duplicateRemoval = await writeCanonicalSource(output, source, manifest, "raw/reuters/runs/run/manifest.json", [{
      ...imageOnly,
      processedBody: "",
      captureStatus: "duplicate",
    }], "raw-sha-3");
    expect(duplicateRemoval.skippedArticles).toEqual([
      expect.objectContaining({ articleId: "reuters:image-only", reason: "duplicate-live-update" }),
    ]);
    const dateAfterDuplicateRemoval = JSON.parse(gunzipSync(await readFile(path.join(
      output, "canonical", "reuters", "dates", "2026", "08", "2026-08-23.json.gz",
    ))).toString("utf8")) as { articles: Array<{ articleId: string }> };
    expect(dateAfterDuplicateRemoval.articles).toEqual([]);
    await expect(readFile(path.join(output, "canonical", "newspapers", "times", "dataset.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rewrites retained Canonical articles when a source asset policy rejects a historical ad", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-times-canonical-asset-policy-"));
    const manifest: SourceCaptureManifest = {
      formatVersion: "jojo-times-raw-source-run/2",
      runId: "run-asset-policy",
      sourceId: source.id,
      sourceName: source.name,
      publicationTimeZone: source.publicationTimeZone,
      startedAt: "2026-09-02T10:00:00Z",
      completedAt: "2026-09-02T10:01:00Z",
      discovery: source.discovery,
      candidateCount: 1,
      fullCount: 1,
      summaryCount: 0,
      metadataCount: 0,
      networkExchangeCount: 1,
      objects: [],
      captureStatus: "pages-complete",
      healthStatus: "healthy",
      complete: true,
    };
    const editorialAsset = {
      id: "asset:editorial",
      type: "image" as const,
      role: "content" as const,
      sourceUrl: "https://image.chinanews.com/cspimp/2026/09-02/editorial.JPG",
      rawObject: "raw/reuters/assets/editorial.jpg",
      mediaType: "image/jpeg",
      size: 20,
      sha256: "editorial-sha",
      afterBlock: 1,
    };
    const advertisementAsset = {
      id: "asset:advertisement",
      type: "image" as const,
      role: "content" as const,
      sourceUrl: "https://www.chinanews.com.cn/ad2008/U947P4T175D633F27513DT20260901095008.jpg",
      rawObject: "raw/reuters/assets/advertisement.jpg",
      mediaType: "image/jpeg",
      size: 32_000,
      sha256: "df88276e1087e01022ed1413f07da9ad4bb0ced782990f40ca91fc316bea561b",
      afterBlock: 2,
    };
    const legacyCandidate: ProcessedCandidate = {
      articleId: "reuters:legacy-ad",
      sourceId: source.id,
      sourceName: source.name,
      language: source.language,
      sourceUrl: "https://www.chinanews.com.cn/cj/2026/09-02/10688570.shtml",
      canonicalUrl: "https://www.chinanews.com.cn/cj/2026/09-02/10688570.shtml",
      title: "Historical article",
      processedBody: [
        "<p>First retained paragraph.</p>",
        '<figure data-asset-id="asset:editorial"><figcaption>Editorial caption</figcaption></figure>',
        "<p>Second retained paragraph.</p>",
        '<figure data-asset-id="asset:advertisement"></figure>',
      ].join(""),
      contentStatus: "full",
      assets: [editorialAsset, advertisementAsset],
      translation: {
        language: "zh-CN",
        title: "历史文章",
        body: {
          format: "html",
          profile: "jojo-semantic-html/1",
          value: '<p>保留的译文。</p><figure data-asset-id="asset:editorial"></figure><figure data-asset-id="asset:advertisement"></figure>',
        },
        provider: "google-gemini-api",
        model: "gemma-test",
        translatedAt: "2026-09-02T10:02:00Z",
        sourceHash: "legacy-source-hash",
      },
      translationStatus: "translated",
      publishedAt: "2026-09-02T05:13:47Z",
      authors: [],
      publisherCategories: [],
      publisherSections: [],
    };
    const first = await writeCanonicalSource(
      output,
      source,
      manifest,
      "raw/reuters/runs/run-asset-policy/manifest.json",
      [legacyCandidate, {
        ...legacyCandidate,
        articleId: "reuters:hf-not-restored",
        title: "Retained article not restored by HF",
        sourceUrl: "https://www.reuters.com/world/not-restored",
        canonicalUrl: "https://www.reuters.com/world/not-restored",
        processedBody: "<p>This object remains available remotely, but not in the dry-run workspace.</p>",
        assets: [],
      }],
      "raw-before-policy",
    );
    const legacyRef = first.articles.find((article) => article.articleId === legacyCandidate.articleId)!;
    const notRestoredRef = first.articles.find((article) => article.articleId === "reuters:hf-not-restored")!;
    await unlink(path.join(output, ...notRestoredRef.object.split("/")));

    const currentCandidate: ProcessedCandidate = {
      ...legacyCandidate,
      articleId: "reuters:current",
      sourceUrl: "https://www.reuters.com/world/current",
      canonicalUrl: "https://www.reuters.com/world/current",
      title: "Current article",
      processedBody: "<p>Current article body without any assets.</p>",
      assets: [],
      publishedAt: "2026-09-03T05:13:47Z",
    };
    const second = await writeCanonicalSource(
      output,
      source,
      { ...manifest, runId: "run-after-policy" },
      "raw/reuters/runs/run-after-policy/manifest.json",
      [],
      "raw-after-policy",
      {
        acceptCanonicalAsset: (asset) => !/^\/ad(?:\d{4})?\//iu.test(new URL(asset.sourceUrl).pathname),
      },
    );

    const migratedRef = second.articles.find((article) => article.articleId === legacyCandidate.articleId)!;
    expect(migratedRef.object).not.toBe(legacyRef.object);
    expect(second.dates).toEqual(["2026-09-02"]);
    expect(second.files).toContain(migratedRef.object);
    const migrated = JSON.parse(gunzipSync(await readFile(path.join(
      output,
      ...migratedRef.object.split("/"),
    ))).toString("utf8")) as CanonicalArticle;
    expect(migrated.assets).toEqual([editorialAsset]);
    expect(migrated.body.value).toContain("asset:editorial");
    expect(migrated.body.value).not.toContain("asset:advertisement");
    expect(migrated.translations?.["zh-CN"]?.body.value).toContain("asset:editorial");
    expect(migrated.translations?.["zh-CN"]?.body.value).not.toContain("asset:advertisement");

    const oldDate = JSON.parse(gunzipSync(await readFile(path.join(
      output,
      "canonical",
      source.id,
      "dates",
      "2026",
      "09",
      "2026-09-02.json.gz",
    ))).toString("utf8")) as { articles: Array<{ articleId: string; object: string }> };
    expect(oldDate.articles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        articleId: legacyCandidate.articleId,
        object: migratedRef.object,
      }),
      expect.objectContaining({
        articleId: "reuters:hf-not-restored",
        object: notRestoredRef.object,
      }),
    ]));
    expect(oldDate.articles.some((article) => article.object === legacyRef.object)).toBe(false);

    const idempotent = await writeCanonicalSource(
      output,
      source,
      { ...manifest, runId: "run-idempotent" },
      "raw/reuters/runs/run-idempotent/manifest.json",
      [currentCandidate],
      "raw-idempotent",
      {
        acceptCanonicalAsset: (asset) => !/^\/ad(?:\d{4})?\//iu.test(new URL(asset.sourceUrl).pathname),
      },
    );
    expect(idempotent.articles.filter((article) => article.articleId === legacyCandidate.articleId)).toEqual([]);
  });
});
