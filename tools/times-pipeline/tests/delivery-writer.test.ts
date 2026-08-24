import { gzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  NEWS_TIMELINE_PROFILE,
  gunzipJoxJson,
  type JojoCatalog,
  type NewsDateManifest,
  type NewsPublisherIndex,
} from "@jojo/content";
import { describe, expect, it } from "vitest";
import type { CanonicalArticle } from "../src/canonical-writer.js";
import { buildNewsDelivery, type RawRunManifest } from "../src/delivery-writer.js";
import type { Candidate, SourceConfig } from "../src/types.js";

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

const secondSource: SourceConfig = {
  ...source,
  id: "second",
  name: "Second News",
  language: "zh-CN",
  discovery: { kind: "official-rss", url: "https://second.test/feed.xml" },
  content: { ...source.content, allowedHostnames: ["second.test"] },
};

function canonical(sourceConfig: SourceConfig, id: string, publishedAt: string, status: "full" | "summary" = "full"): CanonicalArticle {
  return {
    formatVersion: "jojo-news-article/1",
    articleId: `${sourceConfig.id}:${id}`,
    source: { id: sourceConfig.id, name: sourceConfig.name },
    canonicalUrl: `https://${sourceConfig.id}.test/${id}`,
    title: `${sourceConfig.name} ${id}`,
    authors: ["Reporter"],
    language: sourceConfig.language,
    publishedAt,
    publisherCategories: ["World"],
    categories: ["world"],
    body: { format: "html", profile: "jojo-semantic-html/1", value: `<p>${id} full article body</p>` },
    contentStatus: status,
    contentHash: `${id}-hash`,
    provenance: {
      rawRevision: "raw-revision",
      rawRunId: "run-1",
      rawManifest: `raw/news/${sourceConfig.id}/manifest.json`,
      discovery: sourceConfig.discovery,
    },
  };
}

async function writeShard(root: string, sourceId: string, date: string, rows: CanonicalArticle[]) {
  const [year, month] = date.split("-");
  const target = path.join(root, "canonical", "news", sourceId, "articles", year!, month!, `${date}.jsonl.gz`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, gzipSync(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`));
}

describe("news Delivery writer", () => {
  it("publishes one newspaper dataset per source and removes the synthetic Times dataset", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "jojo-news-delivery-workspace-"));
    const deliveryRoot = await mkdtemp(path.join(os.tmpdir(), "jojo-news-delivery-output-"));
    const manifestObject = "raw/news/example/2026/08/23/run-1/manifest.json";
    const rawRoot = path.join(workspaceRoot, ...manifestObject.split("/").slice(0, -1));
    await mkdir(rawRoot, { recursive: true });
    await writeFile(path.join(rawRoot, "manifest.json"), "{}");
    const candidate: Candidate = {
      articleId: "example:lead",
      sourceId: source.id,
      sourceName: source.name,
      language: source.language,
      sourceUrl: "https://example.test/lead",
      canonicalUrl: "https://example.test/lead",
      title: "Example News lead",
      summary: "A concise timeline summary.",
      contentStatus: "full",
      publishedAt: "2026-08-23T09:30:00.000Z",
      authors: ["Reporter"],
      publisherCategories: ["World"],
    };
    await writeFile(path.join(rawRoot, "candidates.jsonl.gz"), gzipSync(`${JSON.stringify(candidate)}\n`));
    await writeShard(workspaceRoot, source.id, "2026-08-23", [
      canonical(source, "lead", "2026-08-23T09:30:00.000Z"),
      canonical(source, "summary", "2026-08-23T09:00:00.000Z", "summary"),
    ]);
    await writeShard(workspaceRoot, secondSource.id, "2026-08-23", [
      canonical(secondSource, "lead", "2026-08-23T08:30:00.000Z"),
    ]);

    const previousIndex: NewsPublisherIndex = {
      formatVersion: "jojo-delivery-index/1",
      revision: 1,
      datasetId: source.id,
      type: "newspaper",
      title: source.name,
      language: source.language,
      contentProfile: NEWS_TIMELINE_PROFILE,
      publicationStatus: "published",
      access: "authenticated",
      updatedAt: "2026-08-22T00:00:00Z",
      items: [{
        itemId: "example:2026-08-22",
        itemKey: "2026-08-22",
        type: "newspaper",
        order: 1,
        title: "Example News · 2026-08-22",
        manifestObject: "items/2026/08/2026-08-22/manifest.jox",
      }],
    };
    const previousCatalog: JojoCatalog = {
      formatVersion: "jojo-catalog/1",
      revision: 1,
      updatedAt: "2026-08-22T00:00:00Z",
      datasets: [{
        datasetId: "reader",
        type: "book",
        title: "Reader",
        language: "zh-CN",
        indexObject: "content/books/reader/index.jox",
      }, {
        datasetId: "times",
        type: "newspaper",
        title: "JOJO 时事",
        language: "mul",
        indexObject: "content/newspapers/times/index.jox",
      }],
    };
    const run: RawRunManifest = {
      runId: "run-1",
      startedAt: "2026-08-23T10:00:00.000Z",
      completedAt: "2026-08-23T10:01:00.000Z",
      windowHours: 24,
      sources: [{ sourceId: source.id, status: "ok", output: { manifest: manifestObject } }],
    };

    const result = await buildNewsDelivery({
      workspaceRoot,
      deliveryRoot,
      run,
      sources: [source, secondSource],
      windowHours: 24,
      previousIndexes: new Map([[source.id, previousIndex]]),
      previousCatalog,
    });

    expect(result.articles).toBe(2);
    expect(result.sources.map((row) => row.sourceId)).toEqual(["example", "second"]);
    expect(result.sources.map((row) => row.indexObject)).toEqual([
      "content/newspapers/example/index.jox",
      "content/newspapers/second/index.jox",
    ]);

    const indexObject = "content/newspapers/example/index.jox";
    const index = await gunzipJoxJson<NewsPublisherIndex>(
      new Uint8Array(await readFile(path.join(deliveryRoot, ...indexObject.split("/")))),
      indexObject,
    );
    expect(index.datasetId).toBe("example");
    expect(index.contentProfile).toBe(NEWS_TIMELINE_PROFILE);
    expect(index.items.map((item) => item.itemKey)).toEqual(["2026-08-23", "2026-08-22"]);

    const manifestObjectKey = "content/newspapers/example/items/2026/08/2026-08-23/manifest.jox";
    const manifest = await gunzipJoxJson<NewsDateManifest>(
      new Uint8Array(await readFile(path.join(deliveryRoot, ...manifestObjectKey.split("/")))),
      manifestObjectKey,
    );
    expect(manifest.datasetId).toBe("example");
    expect(manifest.metadata.source.id).toBe("example");
    expect(manifest.metadata.articles).toHaveLength(1);
    expect(manifest.metadata.articles[0]).toMatchObject({
      id: "example:lead",
      summary: "A concise timeline summary.",
      authors: ["Reporter"],
      categories: ["world"],
    });

    const catalog = await gunzipJoxJson<JojoCatalog>(
      new Uint8Array(await readFile(path.join(deliveryRoot, "catalog.jox"))),
      "catalog.jox",
    );
    expect(catalog.datasets.map((dataset) => dataset.datasetId).sort()).toEqual(["example", "reader", "second"]);
    expect(catalog.datasets.find((dataset) => dataset.datasetId === "example")).toMatchObject({
      contentProfile: NEWS_TIMELINE_PROFILE,
      indexObject: "content/newspapers/example/index.jox",
    });
    await expect(readFile(path.join(deliveryRoot, "content/newspapers/times/index.jox"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
