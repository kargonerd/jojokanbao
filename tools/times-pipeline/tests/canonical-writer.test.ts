import { gunzipSync } from "node:zlib";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeCanonicalSource } from "../src/canonical-writer.js";
import { removeParserArtifacts } from "../src/text.js";
import type { Candidate, SourceCaptureManifest, SourceConfig } from "../src/types.js";

const source: SourceConfig = {
  id: "reuters",
  name: "Reuters",
  language: "en",
  discovery: {
    kind: "sitemap",
    url: "https://www.reuters.com/arc/outboundfeeds/sitemap-index/?outputType=xml",
    maximumPages: 20,
  },
  content: { priority: ["browser-parser", "discovery-summary"], parser: "reuters" },
  archive: { mode: "browser", bpc: true },
  health: { minimumCandidates: 1 },
  enabled: true,
};

describe("canonical writer", () => {
  it("removes RSSHub parser component placeholders from publishable content", () => {
    expect(removeParserArtifacts('<p>Before</p>Unhandled type: inline-plus-widget {"type":"inline-plus-widget"}<p>After</p>'))
      .toBe("<p>Before</p> <p>After</p>");
  });

  it("keeps a summary in Raw but excludes it from Canonical", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-times-canonical-"));
    const manifest: SourceCaptureManifest = {
      formatVersion: "jojo-times-raw-source-run/1",
      runId: "run-1",
      sourceId: "reuters",
      sourceName: "Reuters",
      startedAt: "2026-08-23T10:00:00Z",
      completedAt: "2026-08-23T10:01:00Z",
      discovery: source.discovery,
      candidateCount: 1,
      fullCount: 0,
      summaryCount: 1,
      metadataCount: 0,
      networkExchangeCount: 1,
      objects: [],
      archiveStatus: "recorded-http",
      healthStatus: "healthy",
      complete: true,
    };
    const candidate: Candidate = {
      articleId: "reuters:one",
      sourceId: "reuters",
      sourceName: "Reuters",
      language: "en",
      sourceUrl: "https://www.reuters.com/world/one",
      canonicalUrl: "https://www.reuters.com/world/one",
      title: "One",
      summary: "Summary",
      contentStatus: "summary",
      publishedAt: "2026-08-23T10:00:00Z",
      authors: [],
      publisherCategories: ["World"],
    };
    const result = await writeCanonicalSource(output, source, manifest, "raw/news/reuters/run/manifest.json", [candidate], "raw-sha");
    const shard = path.join(output, "canonical", "news", "reuters", "articles", "2026", "08", "2026-08-23.jsonl.gz");
    expect(gunzipSync(await readFile(shard)).toString("utf8")).toBe("\n");
    expect(result).toMatchObject({ articles: 0, skippedMetadata: 0, skippedNonFull: 1 });
    await expect(readFile(path.join(output, "canonical", "newspapers", "times", "dataset.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never downgrades an existing full article when a later run only has a summary", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-times-canonical-monotonic-"));
    const manifest: SourceCaptureManifest = {
      formatVersion: "jojo-times-raw-source-run/1",
      runId: "run-full",
      sourceId: source.id,
      sourceName: source.name,
      startedAt: "2026-08-23T10:00:00Z",
      completedAt: "2026-08-23T10:01:00Z",
      discovery: source.discovery,
      candidateCount: 1,
      fullCount: 1,
      summaryCount: 0,
      metadataCount: 0,
      networkExchangeCount: 1,
      objects: [],
      archiveStatus: "wacz-complete",
      healthStatus: "healthy",
      complete: true,
    };
    const full: Candidate = {
      articleId: "reuters:one",
      sourceId: source.id,
      sourceName: source.name,
      language: source.language,
      sourceUrl: "https://www.reuters.com/world/one",
      canonicalUrl: "https://www.reuters.com/world/one",
      title: "One",
      summary: "Summary",
      browserBody: "<p>This is the complete article body captured by Chromium.</p>",
      browserArchiveObject: "raw/web-archives/times/full.wacz",
      contentStatus: "full",
      publishedAt: "2026-08-23T10:00:00Z",
      authors: [],
      publisherCategories: ["World"],
    };
    await writeCanonicalSource(output, source, manifest, "raw/news/reuters/full/manifest.json", [full], "raw-full");

    const {
      browserBody: _browserBody,
      browserArchiveObject: _browserArchiveObject,
      ...fullWithoutBrowserCapture
    } = full;
    const summary = { ...fullWithoutBrowserCapture, contentStatus: "summary" as const };
    await writeCanonicalSource(
      output,
      source,
      { ...manifest, runId: "run-summary", fullCount: 0, summaryCount: 1 },
      "raw/news/reuters/summary/manifest.json",
      [summary],
      "raw-summary",
    );

    const shard = path.join(output, "canonical", "news", "reuters", "articles", "2026", "08", "2026-08-23.jsonl.gz");
    const rows = gunzipSync(await readFile(shard)).toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      articleId: "reuters:one",
      contentStatus: "full",
      body: { value: full.browserBody },
      provenance: { rawRevision: "raw-full" },
    });
  });
});
