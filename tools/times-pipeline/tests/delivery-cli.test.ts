import { gzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipJoxJson, type TimesSourceIndex, type TimesTimelineIndex } from "@jojo/content";
import { describe, expect, it } from "vitest";
import { archiveSourceConfig } from "../src/archive/canonical.js";
import { runDelivery, sourcesForDelivery, type ProcessResult } from "../src/delivery-cli.js";
import { buildNewsDelivery } from "../src/delivery-writer.js";
import type { CanonicalArticle, CanonicalWriteResult } from "../src/process/canonical-writer.js";
import type { SourceConfig } from "../src/types.js";

const configuredSource: SourceConfig = {
  id: "example",
  name: "Example News",
  language: "en",
  publicationTimeZone: "UTC",
  discovery: { kind: "official-rss", url: "https://example.test/feed.xml" },
  content: { priority: ["captured-page"] },
  fetch: { strategy: "direct-first", bpc: false },
  health: { minimumCandidates: 1 },
  enabled: true,
};

function emptySourceResult(sourceId: string): CanonicalWriteResult {
  return {
    sourceId,
    dates: [],
    articles: [],
    files: [],
    skippedWithoutFullText: 0,
    unchangedWithoutRefresh: 0,
    unchangedArticles: [],
    skippedArticles: [],
  };
}

async function canonicalSourceResult(
  workspace: string,
  source: SourceConfig,
  date: string,
  suffix: string,
): Promise<CanonicalWriteResult> {
  const contentHash = `${source.id}-${suffix}`;
  const articleId = `${source.id}:${suffix}`;
  const object = `canonical/${source.id}/articles/${contentHash}.json.gz`;
  const publishedAt = `${date}T09:30:00.000Z`;
  const article: CanonicalArticle = {
    formatVersion: "jojo-news-article/2",
    articleId,
    source: { id: source.id, name: source.name },
    canonicalUrl: `https://example.test/${source.id}/${suffix}`,
    title: `${source.name} ${suffix}`,
    authors: [],
    language: source.language,
    publishedAt,
    publisherCategories: [],
    publisherSections: [],
    categories: [],
    body: { format: "html", profile: "jojo-semantic-html/1", value: `<p>${suffix} body</p>` },
    assets: [],
    contentStatus: "full",
    contentHash,
    provenance: {
      rawRevision: "a".repeat(40),
      rawRunId: `archive-${suffix}`,
      rawManifest: `raw/archive/runs/${suffix}.json`,
      discovery: source.discovery,
    },
  };
  const target = path.join(workspace, ...object.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, gzipSync(`${JSON.stringify(article)}\n`));
  return {
    sourceId: source.id,
    dates: [date],
    articles: [{ articleId, object, contentHash, publishedAt }],
    files: [object],
    skippedWithoutFullText: 0,
    unchangedWithoutRefresh: 0,
    unchangedArticles: [],
    skippedArticles: [],
  };
}

describe("Delivery CLI", () => {
  it("injects archive-only source configs only when explicitly enabled", async () => {
    const processResult: ProcessResult = {
      sources: [emptySourceResult("wsj"), emptySourceResult("nikkei-japan")],
    };

    await expect(sourcesForDelivery([configuredSource], processResult, false)).resolves.toEqual([configuredSource]);
    await expect(sourcesForDelivery([configuredSource], processResult, true)).resolves.toEqual([
      configuredSource,
      expect.objectContaining({ id: "nikkei-japan", language: "ja" }),
      expect.objectContaining({ id: "wsj", language: "en" }),
    ]);
  });

  it("restores archive source indexes while reading timeline days only for affected dates", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "jojo-delivery-cli-workspace-"));
    const previousDelivery = await mkdtemp(path.join(os.tmpdir(), "jojo-delivery-cli-previous-"));
    const deliveryOutput = await mkdtemp(path.join(os.tmpdir(), "jojo-delivery-cli-output-"));
    const configRoot = path.join(workspace, "config");
    const configPath = path.join(configRoot, "sources.json");
    await mkdir(configRoot, { recursive: true });
    await writeFile(path.join(configRoot, "example.json"), `${JSON.stringify(configuredSource)}\n`);
    await writeFile(configPath, `${JSON.stringify({ version: 2, sourceFiles: ["example.json"] })}\n`);
    const wsj = archiveSourceConfig("wsj", []);
    const nikkeiJapan = archiveSourceConfig("nikkei-japan", []);
    const oldDate = "2020-01-01";
    const currentDate = "2020-01-02";
    const oldWsj = await canonicalSourceResult(workspace, wsj, oldDate, "old");

    await buildNewsDelivery({
      workspaceRoot: workspace,
      deliveryRoot: previousDelivery,
      generatedAt: `${oldDate}T12:00:00.000Z`,
      sources: [wsj],
      process: { sources: [oldWsj] },
    });

    const unrelatedDay = `content/timeline/dates/2020/01/${oldDate}.jox`;
    await writeFile(path.join(previousDelivery, ...unrelatedDay.split("/")), Buffer.from("corrupt-unrelated-day"));

    const currentWsj = await canonicalSourceResult(workspace, wsj, currentDate, "current");
    const currentNikkei = await canonicalSourceResult(workspace, nikkeiJapan, currentDate, "current");
    const processResult: ProcessResult = { sources: [currentWsj, currentNikkei] };
    const processResultFile = path.join(workspace, "archive-process-result.json");
    await writeFile(processResultFile, `${JSON.stringify(processResult)}\n`);

    const result = await runDelivery(new Map([
      ["config", configPath],
      ["output", workspace],
      ["process-result", processResultFile],
      ["delivery-output", deliveryOutput],
      ["previous-delivery", previousDelivery],
      ["archive-sources", "true"],
    ]));

    expect(result.articles).toBe(2);
    const wsjIndexObject = "content/newspapers/wsj/index.jox";
    const wsjIndex = await gunzipJoxJson<TimesSourceIndex>(
      new Uint8Array(await readFile(path.join(deliveryOutput, ...wsjIndexObject.split("/")))),
      wsjIndexObject,
    );
    expect(wsjIndex.items.map((item) => item.itemKey)).toEqual([currentDate, oldDate]);

    const nikkeiIndexObject = "content/newspapers/nikkei-japan/index.jox";
    const nikkeiIndex = await gunzipJoxJson<TimesSourceIndex>(
      new Uint8Array(await readFile(path.join(deliveryOutput, ...nikkeiIndexObject.split("/")))),
      nikkeiIndexObject,
    );
    expect(nikkeiIndex.items.map((item) => item.itemKey)).toEqual([currentDate]);

    const timelineObject = "content/timeline/index.jox";
    const timeline = await gunzipJoxJson<TimesTimelineIndex>(
      new Uint8Array(await readFile(path.join(deliveryOutput, ...timelineObject.split("/")))),
      timelineObject,
    );
    expect(timeline.dates.map((date) => date.date)).toEqual([currentDate, oldDate]);
    expect(timeline.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "wsj" }),
      expect.objectContaining({ id: "nikkei-japan" }),
    ]));

    const nextDelivery = await mkdtemp(path.join(os.tmpdir(), "jojo-delivery-cli-next-"));
    const liveProcessResultFile = path.join(workspace, "live-process-result.json");
    await writeFile(liveProcessResultFile, `${JSON.stringify({
      sources: [emptySourceResult(configuredSource.id)],
    })}\n`);
    await runDelivery(new Map([
      ["config", configPath],
      ["output", workspace],
      ["process-result", liveProcessResultFile],
      ["delivery-output", nextDelivery],
      ["previous-delivery", deliveryOutput],
    ]));

    const nextTimeline = await gunzipJoxJson<TimesTimelineIndex>(
      new Uint8Array(await readFile(path.join(nextDelivery, ...timelineObject.split("/")))),
      timelineObject,
    );
    expect(nextTimeline.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "wsj" }),
      expect.objectContaining({ id: "nikkei-japan" }),
    ]));
    const persistedWsj = await gunzipJoxJson<TimesSourceIndex>(
      new Uint8Array(await readFile(path.join(nextDelivery, ...wsjIndexObject.split("/")))),
      wsjIndexObject,
    );
    expect(persistedWsj.items.map((item) => item.itemKey)).toEqual([currentDate, oldDate]);
  }, 10_000);
});
