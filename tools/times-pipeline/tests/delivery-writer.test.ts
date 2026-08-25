import { gzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipJoxJson, type JojoCatalog, type TimesDateManifest, type TimesDeliveryIndex } from "@jojo/content";
import { describe, expect, it } from "vitest";
import type { CanonicalArticle } from "../src/canonical-writer.js";
import { buildTimesDelivery, type RawRunManifest } from "../src/delivery-writer.js";
import type { Candidate, SourceCaptureManifest, SourceConfig } from "../src/types.js";

const source: SourceConfig = {
  id: "example",
  name: "Example News",
  language: "en",
  discovery: { kind: "official-rss", url: "https://example.test/feed.xml" },
  content: { priority: ["discovery-body", "discovery-summary"] },
  archive: { mode: "http", bpc: true },
  health: { minimumCandidates: 1 },
  enabled: true,
};

describe("Times Delivery writer", () => {
  it("writes date Jox objects with source health and unavailable cases", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "jojo-times-delivery-workspace-"));
    const deliveryRoot = await mkdtemp(path.join(os.tmpdir(), "jojo-times-delivery-output-"));
    const runId = "run-1";
    const manifestObject = `raw/news/example/2026/08/23/${runId}/manifest.json`;
    const runRoot = path.join(workspaceRoot, ...manifestObject.split("/").slice(0, -1));
    await mkdir(runRoot, { recursive: true });
    const manifest: SourceCaptureManifest = {
      formatVersion: "jojo-times-raw-source-run/1",
      runId,
      sourceId: source.id,
      sourceName: source.name,
      startedAt: "2026-08-23T10:00:00.000Z",
      completedAt: "2026-08-23T10:01:00.000Z",
      discovery: source.discovery,
      candidateCount: 3,
      fullCount: 1,
      summaryCount: 1,
      metadataCount: 1,
      networkExchangeCount: 2,
      objects: [],
      archiveStatus: "recorded-http",
      healthStatus: "healthy",
      complete: true,
    };
    await writeFile(path.join(runRoot, "manifest.json"), JSON.stringify(manifest));
    const candidates: Candidate[] = [{
      articleId: "example:full",
      sourceId: source.id,
      sourceName: source.name,
      language: source.language,
      sourceUrl: "https://example.test/full",
      canonicalUrl: "https://example.test/full",
      title: "Full story",
      summary: "Full summary",
      discoveryBody: "<p>Full body</p>",
      contentStatus: "full",
      publishedAt: "2026-08-23T09:30:00.000Z",
      authors: [],
      publisherCategories: [],
    }, {
      articleId: "example:summary",
      sourceId: source.id,
      sourceName: source.name,
      language: source.language,
      sourceUrl: "https://example.test/summary",
      canonicalUrl: "https://example.test/summary",
      title: "Summary-only story",
      summary: "Summary without a full body",
      contentStatus: "summary",
      publishedAt: "2026-08-23T09:15:00.000Z",
      authors: [],
      publisherCategories: [],
    }, {
      articleId: "example:missing",
      sourceId: source.id,
      sourceName: source.name,
      language: source.language,
      sourceUrl: "https://example.test/missing",
      canonicalUrl: "https://example.test/missing",
      title: "Missing story",
      contentStatus: "metadata",
      publishedAt: "2026-08-23T09:00:00.000Z",
      authors: [],
      publisherCategories: [],
    }];
    await writeFile(path.join(runRoot, "candidates.jsonl.gz"), gzipSync(`${candidates.map((row) => JSON.stringify(row)).join("\n")}\n`));
    const canonical: CanonicalArticle = {
      formatVersion: "jojo-news-article/1",
      articleId: "example:full",
      source: { id: source.id, name: source.name },
      canonicalUrl: "https://example.test/full",
      title: "Full story",
      authors: [],
      language: "en",
      publishedAt: "2026-08-23T09:30:00.000Z",
      publisherCategories: [],
      categories: [],
      body: { format: "html", profile: "jojo-semantic-html/1", value: "<p>Full body</p>" },
      contentStatus: "full",
      contentHash: "full-hash",
      provenance: {
        rawRevision: "raw-revision",
        rawRunId: runId,
        rawManifest: manifestObject,
        discovery: source.discovery,
      },
    };
    const summaryCanonical: CanonicalArticle = {
      ...canonical,
      articleId: "example:summary",
      canonicalUrl: "https://example.test/summary",
      title: "Summary-only story",
      publishedAt: "2026-08-23T09:15:00.000Z",
      body: { format: "text", value: "Summary without a full body" },
      contentStatus: "summary",
      contentHash: "summary-hash",
    };
    const shard = path.join(workspaceRoot, "canonical/news/example/articles/2026/08/2026-08-23.jsonl.gz");
    await mkdir(path.dirname(shard), { recursive: true });
    await writeFile(shard, gzipSync(`${JSON.stringify(canonical)}\n${JSON.stringify(summaryCanonical)}\n`));
    const run: RawRunManifest = {
      runId,
      startedAt: "2026-08-23T10:00:00.000Z",
      completedAt: "2026-08-23T10:01:00.000Z",
      windowHours: 24,
      sources: [{ sourceId: source.id, status: "ok", output: { manifest: manifestObject } }],
      browserArchive: {
        captureBySource: [{ sourceId: source.id, attempts: 1, succeeded: 0, failed: 1 }],
        failedCases: [{
          articleId: "example:full",
          sourceId: source.id,
          title: "Full story",
          url: "https://example.test/full",
          httpStatus: 403,
        }],
      },
    };

    const previousIndex: TimesDeliveryIndex = {
      formatVersion: "jojo-delivery-index/1",
      revision: 1,
      datasetId: "times",
      type: "newspaper",
      title: "JOJO 时事",
      language: "mul",
      publicationStatus: "published",
      access: "authenticated",
      items: [{
        itemId: "times:2026-08-21",
        itemKey: "2026-08-21",
        type: "newspaper",
        order: 1,
        title: "时事 · 2026-08-21",
        manifestObject: "items/2026/08/2026-08-21/manifest.jox",
        publicationStatus: "published",
        access: "authenticated",
      }],
      updatedAt: "2026-08-21T10:00:00.000Z",
      window: { from: "2026-08-20T10:00:00.000Z", to: "2026-08-21T10:00:00.000Z", hours: 24 },
      sourceHealth: [],
      unavailableCases: [],
    };
    const previousCatalog: JojoCatalog = {
      formatVersion: "jojo-catalog/1",
      revision: 1,
      updatedAt: "2026-08-21T10:00:00.000Z",
      datasets: [{
        datasetId: "reader",
        type: "book",
        title: "Reader",
        language: "zh-CN",
        itemCount: 1,
        indexObject: "content/books/reader/index.jox",
        publicationStatus: "published",
        access: "public",
      }],
    };
    const result = await buildTimesDelivery({
      workspaceRoot,
      deliveryRoot,
      run,
      sources: [source],
      windowHours: 24,
      previousIndex,
      previousCatalog,
    });
    const indexBytes = new Uint8Array(await readFile(path.join(deliveryRoot, ...result.indexObject.split("/"))));
    const index = await gunzipJoxJson<TimesDeliveryIndex>(indexBytes, result.indexObject);
    expect(index.items.map((item) => item.itemKey)).toEqual(["2026-08-23", "2026-08-21"]);
    expect(index.sourceHealth[0]).toMatchObject({
      discovered: 3,
      delivered: 1,
      full: 1,
      summary: 1,
      unavailable: 2,
      browserAttempts: 1,
      browserFailed: 1,
      availabilityRate: 0.3333,
      fullTextRate: 0.3333,
      healthScore: 33.3,
    });
    expect(index.unavailableCases).toHaveLength(3);
    expect(index.unavailableCases).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "example:missing", reason: "metadata-only" }),
      expect.objectContaining({ id: "example:summary", reason: "full-text-pending" }),
      expect.objectContaining({ id: "example:full:browser-capture", reason: "browser-capture-failed" }),
    ]));

    const manifestKey = "content/newspapers/times/items/2026/08/2026-08-23/manifest.jox";
    const dateBytes = new Uint8Array(await readFile(path.join(deliveryRoot, ...manifestKey.split("/"))));
    const dateManifest = await gunzipJoxJson<TimesDateManifest>(dateBytes, manifestKey);
    expect(dateManifest.metadata.articles).toHaveLength(1);
    expect(dateManifest.metadata.articles[0]).toMatchObject({ id: "example:full", contentStatus: "full" });
    const catalogBytes = new Uint8Array(await readFile(path.join(deliveryRoot, "catalog.jox")));
    const catalog = await gunzipJoxJson<JojoCatalog>(catalogBytes, "catalog.jox");
    expect(catalog.datasets.map((dataset) => dataset.datasetId)).toEqual(["reader", "times"]);
  });
});
