import { gunzipSync } from "node:zlib";
import { mkdtemp, readFile } from "node:fs/promises";
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
      updatedAt: "2026-08-23T10:20:00Z",
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
      publishedAt: "2026-08-23T10:00:00Z",
      updatedAt: "2026-08-23T10:20:00Z",
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
});
