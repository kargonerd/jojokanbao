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

  it("writes one media/day JSONL shard without a Times canonical copy", async () => {
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
      publisherSections: [{ id: "world", name: "World" }],
    };
    await writeCanonicalSource(output, source, manifest, "raw/news/reuters/run/manifest.json", [candidate], "raw-sha");
    const shard = path.join(output, "canonical", "news", "reuters", "articles", "2026", "08", "2026-08-23.jsonl.gz");
    const row = JSON.parse(gunzipSync(await readFile(shard)).toString("utf8")) as Record<string, unknown>;
    expect(row).toMatchObject({
      articleId: "reuters:one",
      contentStatus: "summary",
      publisherSections: [{ id: "world", name: "World" }],
    });
    await expect(readFile(path.join(output, "canonical", "newspapers", "times", "dataset.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
