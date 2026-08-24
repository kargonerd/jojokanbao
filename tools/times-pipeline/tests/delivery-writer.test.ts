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
  content: {
    priority: ["discovery-body", "discovery-summary"],
    allowedHostnames: ["example.test"],
    excludedPathPrefixes: ["/video/"],
  },
  archive: { mode: "http", bpc: true },
  health: { minimumCandidates: 1 },
  enabled: true,
};

const preservedSource: SourceConfig = {
  ...source,
  id: "preserved",
  name: "Preserved News",
  discovery: { kind: "official-rss", url: "https://preserved.test/feed.xml" },
  content: {
    ...source.content,
    allowedHostnames: ["preserved.test"],
  },
};

describe("Times Delivery writer", () => {
  it("does not report a successful interval with only policy exclusions as unavailable", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "jojo-times-video-workspace-"));
    const deliveryRoot = await mkdtemp(path.join(os.tmpdir(), "jojo-times-video-output-"));
    const runId = "video-run";
    const manifestObject = `raw/news/example/2026/08/23/${runId}/manifest.json`;
    const runRoot = path.join(workspaceRoot, ...manifestObject.split("/").slice(0, -1));
    await mkdir(runRoot, { recursive: true });
    await writeFile(path.join(runRoot, "manifest.json"), JSON.stringify({
      formatVersion: "jojo-times-raw-source-run/1",
      runId,
      sourceId: source.id,
      sourceName: source.name,
      startedAt: "2026-08-23T10:00:00.000Z",
      completedAt: "2026-08-23T10:01:00.000Z",
      discovery: source.discovery,
      candidateCount: 0,
      fullCount: 0,
      summaryCount: 0,
      metadataCount: 0,
      networkExchangeCount: 1,
      objects: [],
      archiveStatus: "recorded-http",
      healthStatus: "healthy",
      complete: true,
    } satisfies SourceCaptureManifest));
    await writeFile(path.join(runRoot, "candidates.jsonl.gz"), gzipSync(""));
    const result = await buildTimesDelivery({
      workspaceRoot,
      deliveryRoot,
      run: {
        runId,
        startedAt: "2026-08-23T10:00:00.000Z",
        completedAt: "2026-08-23T10:01:00.000Z",
        sources: [{ sourceId: source.id, status: "ok", output: { manifest: manifestObject } }],
      },
      sources: [source],
      windowHours: 24,
    });

    expect(result.unavailableCases).toEqual([]);
    expect(result.sourceHealth[0]).toMatchObject({
      status: "healthy",
      discovered: 0,
      delivered: 0,
      unavailable: 0,
      availabilityRate: 1,
      fullTextRate: 1,
      healthScore: 100,
    });
  });

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
      candidateCount: 4,
      fullCount: 1,
      summaryCount: 2,
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
      summary: "This is only a feed summary.",
      contentStatus: "summary",
      publishedAt: "2026-08-23T09:15:00.000Z",
      authors: [],
      publisherCategories: [],
    }, {
      articleId: "example:video",
      sourceId: source.id,
      sourceName: source.name,
      language: source.language,
      sourceUrl: "https://example.test/video/clip",
      canonicalUrl: "https://example.test/video/clip",
      title: "Video clip",
      summary: "Video-only content.",
      contentStatus: "summary",
      publishedAt: "2026-08-23T09:10:00.000Z",
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
    const staleSummaryCanonical: CanonicalArticle = {
      ...canonical,
      articleId: "example:summary",
      canonicalUrl: "https://example.test/summary",
      title: "Summary-only story",
      publishedAt: "2026-08-23T09:15:00.000Z",
      body: { format: "text", value: "This is only a feed summary." },
      contentStatus: "summary",
      contentHash: "summary-hash",
    };
    const rolledOutCanonical: CanonicalArticle = {
      ...canonical,
      articleId: "example:rolled-out",
      canonicalUrl: "https://example.test/rolled-out",
      title: "Full story no longer present in the latest feed page",
      publishedAt: "2026-08-23T08:45:00.000Z",
      contentHash: "rolled-out-hash",
    };
    const shard = path.join(workspaceRoot, "canonical/news/example/articles/2026/08/2026-08-23.jsonl.gz");
    await mkdir(path.dirname(shard), { recursive: true });
    await writeFile(shard, gzipSync(`${JSON.stringify(canonical)}\n${JSON.stringify(staleSummaryCanonical)}\n${JSON.stringify(rolledOutCanonical)}\n`));
    const preservedCanonical: CanonicalArticle = {
      ...canonical,
      articleId: "preserved:full",
      source: { id: preservedSource.id, name: preservedSource.name },
      canonicalUrl: "https://preserved.test/full",
      title: "Full article from a source outside this targeted Raw run",
      publishedAt: "2026-08-23T08:15:00.000Z",
      contentHash: "preserved-hash",
      provenance: {
        ...canonical.provenance,
        discovery: preservedSource.discovery,
      },
    };
    const preservedShard = path.join(workspaceRoot, "canonical/news/preserved/articles/2026/08/2026-08-23.jsonl.gz");
    await mkdir(path.dirname(preservedShard), { recursive: true });
    await writeFile(preservedShard, gzipSync(`${JSON.stringify(preservedCanonical)}\n`));
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
        }, {
          articleId: "example:video",
          sourceId: source.id,
          title: "Video clip",
          url: "https://example.test/video/clip",
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
      unavailableCases: [{
        id: "example:previous-pending",
        source: { id: source.id, name: source.name, language: source.language },
        reason: "full-text-pending",
        stage: "capture",
        message: "Still waiting for full text.",
        title: "A story that rolled out of the latest feed page",
        url: "https://example.test/previous-pending",
        publishedAt: "2026-08-23T08:30:00.000Z",
      }],
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
      sources: [source, preservedSource],
      windowHours: 24,
      previousIndex,
      previousCatalog,
    });
    const indexBytes = new Uint8Array(await readFile(path.join(deliveryRoot, ...result.indexObject.split("/"))));
    const index = await gunzipJoxJson<TimesDeliveryIndex>(indexBytes, result.indexObject);
    expect(index.items.map((item) => item.itemKey)).toEqual(["2026-08-23", "2026-08-21"]);
    expect(index.sourceHealth[0]).toMatchObject({
      discovered: 5,
      delivered: 2,
      full: 2,
      summary: 0,
      unavailable: 3,
      browserAttempts: 1,
      browserFailed: 1,
      healthScore: 40,
    });
    expect(index.sourceHealth[1]).toMatchObject({
      source: { id: "preserved" },
      status: "healthy",
      discovered: 1,
      delivered: 1,
      unavailable: 0,
    });
    expect(index.unavailableCases).toHaveLength(3);
    expect(index.unavailableCases).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "example:missing", reason: "metadata-only" }),
      expect.objectContaining({ id: "example:summary", reason: "full-text-pending" }),
      expect.objectContaining({ id: "example:previous-pending", reason: "full-text-pending" }),
    ]));

    const manifestKey = "content/newspapers/times/items/2026/08/2026-08-23/manifest.jox";
    const dateBytes = new Uint8Array(await readFile(path.join(deliveryRoot, ...manifestKey.split("/"))));
    const dateManifest = await gunzipJoxJson<TimesDateManifest>(dateBytes, manifestKey);
    expect(dateManifest.metadata.articles).toHaveLength(3);
    expect(dateManifest.metadata.articles[0]).toMatchObject({ id: "example:full", contentStatus: "full" });
    expect(dateManifest.metadata.articles[1]).toMatchObject({ id: "example:rolled-out", contentStatus: "full" });
    expect(dateManifest.metadata.articles[2]).toMatchObject({ id: "preserved:full", contentStatus: "full" });
    const catalogBytes = new Uint8Array(await readFile(path.join(deliveryRoot, "catalog.jox")));
    const catalog = await gunzipJoxJson<JojoCatalog>(catalogBytes, "catalog.jox");
    expect(catalog.datasets.map((dataset) => dataset.datasetId)).toEqual(["reader", "times"]);
  });
});
