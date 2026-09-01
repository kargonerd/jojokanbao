import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  TimesDateManifest,
  TimesDeliveryArticle,
  TimesSourceIndex,
  TimesTimelineDay,
  TimesTimelineIndex,
} from "@jojo/content";
import { describe, expect, it } from "vitest";
import { buildNewsDelivery, readJoxJson } from "../src/delivery-writer.js";
import { sha256 } from "../src/identity.js";
import { runProcess } from "../src/process-cli.js";
import type { ProcessedCandidate } from "../src/process/article.js";
import {
  writeCanonicalSource,
  type CanonicalArticle,
  type CanonicalDateIndex,
  type CanonicalWriteResult,
} from "../src/process/canonical-writer.js";
import { sourceStaleCanonicalBodyClassifier } from "../src/sources/registry.js";
import type { Candidate, SourceCaptureManifest, SourceConfig } from "../src/types.js";

const ISSUE_DATE = "2026-08-28";
const PUBLISHED_AT = `${ISSUE_DATE}T09:30:00.000Z`;
const CONSUMER_OFFER_BODY = `<p>Try unlimited access</p>
  <p>Complete digital access to quality FT journalism on any device.</p>
  <p>Explore our full range of subscriptions.</p>
  <p>Discover all the plans currently available in your country.</p>
  <p>Digital access for organisations. Includes exclusive features and content.</p>`;
const LEGITIMATE_BODY = `<p>Ministers announced a detailed fiscal plan after weeks of negotiations.</p>
  <p>Officials described the timetable, funding and parliamentary response.</p>
  <p>Independent analysts said the policy would have measurable economic effects.</p>`;

function source(id = "ft", name = "Financial Times"): SourceConfig {
  return {
    id,
    name,
    language: "en",
    publicationTimeZone: "Europe/London",
    discovery: { kind: "official-rss", url: `https://example.test/${id}.xml` },
    content: { priority: ["captured-page", "discovery-summary"], parser: id },
    fetch: { strategy: "browser-first", bpc: true },
    health: { minimumCandidates: 1 },
    enabled: true,
  };
}

function manifest(value: SourceConfig, candidateCount: number): SourceCaptureManifest {
  return {
    formatVersion: "jojo-times-raw-source-run/2",
    runId: "run-ft-recovery",
    sourceId: value.id,
    sourceName: value.name,
    publicationTimeZone: value.publicationTimeZone,
    startedAt: "2026-08-31T00:00:00.000Z",
    completedAt: "2026-08-31T00:01:00.000Z",
    discovery: value.discovery,
    candidateCount,
    fullCount: 0,
    summaryCount: candidateCount,
    metadataCount: 0,
    networkExchangeCount: candidateCount,
    objects: [],
    captureStatus: "pages-complete",
    healthStatus: "healthy",
    complete: true,
  };
}

function accessOfferAssessment(marker = "consumer-subscription-offer"): NonNullable<Candidate["bodyAssessment"]> {
  return {
    attempts: [{
      origin: "captured-page",
      extractionPath: "publisher-extractor",
      completeness: "truncated",
      characters: 420,
      contentBlocks: 5,
      minimumCharacters: 800,
      minimumContentBlocks: 3,
      verdict: "rejected",
      rejectReason: "publisher-truncated",
      evidence: { kind: "access-offer", marker },
    }],
  };
}

function ordinaryMissingAssessment(): NonNullable<Candidate["bodyAssessment"]> {
  return {
    attempts: [{
      origin: "captured-page",
      extractionPath: "generic-selector",
      completeness: "unknown",
      characters: 0,
      contentBlocks: 0,
      minimumCharacters: 800,
      minimumContentBlocks: 3,
      verdict: "rejected",
      rejectReason: "not-extracted",
    }],
  };
}

function failedCandidate(
  value: SourceConfig,
  articleId: string,
  bodyAssessment: NonNullable<Candidate["bodyAssessment"]> = accessOfferAssessment(),
  captureStatus: Candidate["captureStatus"] = "failed",
): ProcessedCandidate {
  return {
    articleId,
    sourceId: value.id,
    sourceName: value.name,
    language: value.language,
    sourceUrl: `https://www.ft.com/content/${articleId.split(":").at(-1)}`,
    canonicalUrl: `https://www.ft.com/content/${articleId.split(":").at(-1)}`,
    title: `Story ${articleId}`,
    contentStatus: "summary",
    captureStatus,
    bodyAssessment,
    publishedAt: PUBLISHED_AT,
    authors: [],
    publisherCategories: [],
  };
}

function canonicalArticle(value: SourceConfig, articleId: string, body: string): CanonicalArticle {
  const contentHash = sha256(`${articleId}\n${body}`);
  return {
    formatVersion: "jojo-news-article/2",
    articleId,
    source: { id: value.id, name: value.name },
    canonicalUrl: `https://www.ft.com/content/${articleId.split(":").at(-1)}`,
    title: `Prior ${articleId}`,
    authors: [],
    language: value.language,
    publishedAt: PUBLISHED_AT,
    publisherCategories: [],
    publisherSections: [],
    categories: [],
    body: { format: "html", profile: "jojo-semantic-html/1", value: body },
    assets: [],
    contentStatus: "full",
    contentHash,
    provenance: {
      rawRevision: "prior-revision",
      rawRunId: "prior-run",
      rawManifest: `raw/${value.id}/runs/prior/manifest.json`,
      discovery: value.discovery,
    },
  };
}

async function writePreviousCanonical(
  output: string,
  value: SourceConfig,
  rows: ReadonlyArray<{ articleId: string; body: string }>,
): Promise<void> {
  const articles = [];
  for (const row of rows) {
    const article = canonicalArticle(value, row.articleId, row.body);
    const object = `canonical/${value.id}/articles/${article.contentHash}.json.gz`;
    const target = path.join(output, ...object.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, gzipSync(`${JSON.stringify(article)}\n`));
    articles.push({ articleId: row.articleId, object, contentHash: article.contentHash, publishedAt: article.publishedAt });
  }
  const dateIndex: CanonicalDateIndex = {
    formatVersion: "jojo-news-date/1",
    source: { id: value.id, name: value.name, language: value.language },
    issueDate: ISSUE_DATE,
    updatedAt: "2026-08-30T00:00:00.000Z",
    articles,
  };
  const target = path.join(output, "canonical", value.id, "dates", "2026", "08", `${ISSUE_DATE}.json.gz`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, gzipSync(`${JSON.stringify(dateIndex)}\n`));
}

async function gzipJson<T>(root: string, object: string): Promise<T> {
  return JSON.parse(gunzipSync(await readFile(path.join(root, ...object.split("/")))).toString("utf8")) as T;
}

async function joxJson<T>(root: string, object: string): Promise<T> {
  return readJoxJson<T>(new Uint8Array(await readFile(path.join(root, ...object.split("/")))), object);
}

function previousDeliveryArticle(
  value: SourceConfig,
  articleId: string,
  date = ISSUE_DATE,
): TimesDeliveryArticle {
  return {
    id: articleId,
    title: `Delivered ${articleId}`,
    contentStatus: "full",
    url: `https://example.test/${articleId}`,
    publishedAt: `${date}T09:30:00.000Z`,
    issueDate: date,
    language: value.language,
    source: { id: value.id, name: value.name, language: value.language },
    articleObject: `content/newspapers/${value.id}/articles/${articleId}.jox`,
    assets: [],
  };
}

function previousSourceIndex(value: SourceConfig, dates: string[]): TimesSourceIndex {
  return {
    formatVersion: "jojo-delivery-index/1",
    revision: 1,
    datasetId: `news-${value.id}`,
    type: "newspaper",
    title: value.name,
    language: value.language,
    source: { id: value.id, name: value.name, language: value.language },
    items: dates.map((date, index) => ({
      itemId: `${value.id}:${date}`,
      itemKey: date,
      type: "newspaper",
      order: index + 1,
      title: `${value.name} · ${date}`,
      manifestObject: `dates/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.jox`,
    })),
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

function skippedSource(
  value: SourceConfig,
  dates: string[],
  articles: CanonicalWriteResult["skippedArticles"],
): CanonicalWriteResult {
  return {
    sourceId: value.id,
    dates,
    articles: [],
    files: [],
    skippedWithoutFullText: articles.length,
    unchangedWithoutRefresh: 0,
    unchangedArticles: [],
    skippedArticles: articles,
  };
}

describe("FT stale access-offer removal", () => {
  it("removes only a previously polluted FT body from Canonical and is idempotent", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-ft-stale-canonical-"));
    const ft = source();
    const pollutedId = "ft:polluted";
    const legitimateId = "ft:legitimate";
    const networkId = "ft:network-failure";
    const hardPaywallId = "ft:hard-paywall";
    await writePreviousCanonical(output, ft, [
      { articleId: pollutedId, body: CONSUMER_OFFER_BODY },
      { articleId: legitimateId, body: LEGITIMATE_BODY },
      { articleId: networkId, body: CONSUMER_OFFER_BODY },
      { articleId: hardPaywallId, body: CONSUMER_OFFER_BODY },
    ]);
    const classifyStaleCanonicalBody = sourceStaleCanonicalBodyClassifier(ft.id);
    expect(classifyStaleCanonicalBody).toBeDefined();
    expect(sourceStaleCanonicalBodyClassifier("aljazeera")).toBeUndefined();
    const candidates = [
      failedCandidate(ft, pollutedId),
      failedCandidate(ft, legitimateId),
      failedCandidate(ft, networkId, ordinaryMissingAssessment()),
      failedCandidate(ft, hardPaywallId, accessOfferAssessment(), "hard-paywall"),
    ];

    const first = await writeCanonicalSource(
      output,
      ft,
      manifest(ft, candidates.length),
      "raw/ft/runs/run-ft-recovery/manifest.json",
      candidates,
      "recovery-revision",
      { ...(classifyStaleCanonicalBody ? { classifyStaleCanonicalBody } : {}) },
    );
    expect(first.skippedArticles).toEqual(expect.arrayContaining([
      expect.objectContaining({ articleId: pollutedId, reason: "stale-publisher-access-offer" }),
      expect.objectContaining({ articleId: legitimateId, reason: "full-text-missing" }),
      expect.objectContaining({ articleId: networkId, reason: "full-text-missing" }),
      expect.objectContaining({ articleId: hardPaywallId, reason: "hard-paywall" }),
    ]));
    expect(first.dates).toEqual([ISSUE_DATE]);
    const dateObject = `canonical/ft/dates/2026/08/${ISSUE_DATE}.json.gz`;
    const firstDate = await gzipJson<CanonicalDateIndex>(output, dateObject);
    expect(firstDate.articles.map((row) => row.articleId).toSorted()).toEqual([
      hardPaywallId,
      legitimateId,
      networkId,
    ].toSorted());

    const second = await writeCanonicalSource(
      output,
      ft,
      manifest(ft, candidates.length),
      "raw/ft/runs/run-ft-recovery/manifest.json",
      candidates,
      "recovery-revision-2",
      { ...(classifyStaleCanonicalBody ? { classifyStaleCanonicalBody } : {}) },
    );
    expect(second.skippedArticles.find((row) => row.articleId === pollutedId)?.reason).toBe("full-text-missing");
    expect(second.dates).toEqual([]);
    expect((await gzipJson<CanonicalDateIndex>(output, dateObject)).articles).toEqual(firstDate.articles);

    const ajOutput = await mkdtemp(path.join(os.tmpdir(), "jojo-aj-truncated-canonical-"));
    const alJazeera = source("aljazeera", "Al Jazeera");
    const ajId = "aljazeera:live";
    await writePreviousCanonical(ajOutput, alJazeera, [{ articleId: ajId, body: CONSUMER_OFFER_BODY }]);
    const ajResult = await writeCanonicalSource(
      ajOutput,
      alJazeera,
      manifest(alJazeera, 1),
      "raw/aljazeera/runs/run/manifest.json",
      [failedCandidate(alJazeera, ajId)],
      "aj-revision",
    );
    expect(ajResult.skippedArticles).toEqual([
      expect.objectContaining({ articleId: ajId, reason: "full-text-missing" }),
    ]);
    expect((await gzipJson<CanonicalDateIndex>(ajOutput, `canonical/aljazeera/dates/2026/08/${ISSUE_DATE}.json.gz`))
      .articles.map((row) => row.articleId)).toEqual([ajId]);
  });

  it("applies the new reason to timeline days, source-date manifests and source indexes only", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "jojo-ft-stale-delivery-workspace-"));
    const deliveryRoot = await mkdtemp(path.join(os.tmpdir(), "jojo-ft-stale-delivery-output-"));
    const ft = source();
    const alJazeera = source("aljazeera", "Al Jazeera");
    const emptyDate = "2026-08-27";
    const staleId = "ft:stale";
    const soleStaleId = "ft:sole-stale";
    const ordinaryId = "ft:ordinary-missing";
    const hardId = "ft:hard-paywall";
    const ajId = "aljazeera:publisher-truncated";
    const day = (date: string, articles: TimesDeliveryArticle[]): TimesTimelineDay => ({
      formatVersion: "jojo-news-timeline-day/1",
      date,
      updatedAt: "2026-08-30T00:00:00.000Z",
      articles,
    });
    const firstDay = day(ISSUE_DATE, [
      previousDeliveryArticle(ft, staleId),
      previousDeliveryArticle(ft, ordinaryId),
      previousDeliveryArticle(ft, hardId),
      previousDeliveryArticle(alJazeera, ajId),
    ]);
    const secondDay = day(emptyDate, [previousDeliveryArticle(ft, soleStaleId, emptyDate)]);
    const previousTimeline: TimesTimelineIndex = {
      formatVersion: "jojo-news-timeline-index/1",
      updatedAt: "2026-08-30T00:00:00.000Z",
      dates: [
        { date: ISSUE_DATE, object: `dates/2026/08/${ISSUE_DATE}.jox`, articleCount: firstDay.articles.length },
        { date: emptyDate, object: `dates/2026/08/${emptyDate}.jox`, articleCount: secondDay.articles.length },
      ],
      sources: [ft, alJazeera].map((value) => ({ id: value.id, name: value.name, language: value.language })),
    };
    const skipped = (
      articleId: string,
      reason: CanonicalWriteResult["skippedArticles"][number]["reason"],
      value = ft,
      date = ISSUE_DATE,
    ): CanonicalWriteResult["skippedArticles"][number] => ({
      articleId,
      title: articleId,
      canonicalUrl: `https://example.test/${articleId}`,
      publishedAt: `${date}T09:30:00.000Z`,
      reason,
      contentStatus: "summary",
      captureStatus: reason === "hard-paywall" ? "hard-paywall" : "failed",
    });
    const process = {
      sources: [
        skippedSource(ft, [emptyDate, ISSUE_DATE], [
          skipped(staleId, "stale-publisher-access-offer"),
          skipped(soleStaleId, "stale-publisher-access-offer", ft, emptyDate),
          skipped(ordinaryId, "full-text-missing"),
          skipped(hardId, "hard-paywall"),
        ]),
        skippedSource(alJazeera, [], [skipped(ajId, "full-text-missing", alJazeera)]),
      ],
    };

    await buildNewsDelivery({
      workspaceRoot,
      deliveryRoot,
      generatedAt: "2026-08-31T01:00:00.000Z",
      sources: [ft, alJazeera],
      process,
      previousTimelineIndex: previousTimeline,
      previousTimelineDays: new Map([[ISSUE_DATE, firstDay], [emptyDate, secondDay]]),
      previousSourceIndexes: new Map([
        [ft.id, previousSourceIndex(ft, [ISSUE_DATE, emptyDate])],
        [alJazeera.id, previousSourceIndex(alJazeera, [ISSUE_DATE])],
      ]),
    });

    const dayObject = `content/timeline/dates/2026/08/${ISSUE_DATE}.jox`;
    const cleanedDay = await joxJson<TimesTimelineDay>(deliveryRoot, dayObject);
    expect(cleanedDay.articles.map((row) => row.id).toSorted()).toEqual([ajId, hardId, ordinaryId].toSorted());
    const emptyDayObject = `content/timeline/dates/2026/08/${emptyDate}.jox`;
    expect((await joxJson<TimesTimelineDay>(deliveryRoot, emptyDayObject)).articles).toEqual([]);
    const timeline = await joxJson<TimesTimelineIndex>(deliveryRoot, "content/timeline/index.jox");
    expect(timeline.dates).toEqual([
      expect.objectContaining({ date: ISSUE_DATE, articleCount: 3 }),
    ]);
    const ftIndex = await joxJson<TimesSourceIndex>(deliveryRoot, "content/newspapers/ft/index.jox");
    expect(ftIndex.items.map((item) => item.itemKey)).toEqual([ISSUE_DATE]);
    const ajIndex = await joxJson<TimesSourceIndex>(deliveryRoot, "content/newspapers/aljazeera/index.jox");
    expect(ajIndex.items.map((item) => item.itemKey)).toEqual([ISSUE_DATE]);
    const ftManifest = await joxJson<TimesDateManifest>(
      deliveryRoot,
      `content/newspapers/ft/dates/2026/08/${ISSUE_DATE}.jox`,
    );
    expect(ftManifest.metadata.articles.map((row) => row.id).toSorted()).toEqual([hardId, ordinaryId].toSorted());
    expect((ftManifest.content.articles ?? []).map((row) => row.id).toSorted()).toEqual([hardId, ordinaryId].toSorted());
  });

  it("cleans a 168-hour FT replay end to end and stays clean on a second Process run", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-ft-168h-process-"));
    const deliveryRoot = await mkdtemp(path.join(os.tmpdir(), "jojo-ft-168h-delivery-"));
    const ft = JSON.parse(await readFile(path.resolve("src/sources/ft/source.json"), "utf8")) as SourceConfig;
    const staleId = "ft:5e6db1ad-6ea5-44db-80fd-fd7073d9e676";
    const keptId = "ft:legitimate-neighbour";
    await writePreviousCanonical(output, ft, [
      { articleId: staleId, body: CONSUMER_OFFER_BODY },
      { articleId: keptId, body: LEGITIMATE_BODY },
    ]);

    const rawPageObject = `raw/ft/runs/2026/08/31/run-ft-168h/pages/${staleId.slice(3)}/metadata.json`;
    const rawPagePath = path.join(output, ...rawPageObject.split("/"));
    await mkdir(path.dirname(rawPagePath), { recursive: true });
    await writeFile(path.join(path.dirname(rawPagePath), "original.html.gz"), gzipSync(
      `<main><div data-access-offer>${CONSUMER_OFFER_BODY}</div></main>`,
    ));
    await writeFile(path.join(path.dirname(rawPagePath), "rendered.html.gz"), gzipSync(
      "<main><div data-ft-shell></div></main>",
    ));
    await writeFile(rawPagePath, JSON.stringify({
      formatVersion: "jojo-raw-page/1",
      finalUrl: `https://www.ft.com/content/${staleId.slice(3)}`,
      originalHtml: "original.html.gz",
      renderedHtml: "rendered.html.gz",
    }));
    const { bodyAssessment: _bodyAssessment, ...candidateWithoutAssessment } = failedCandidate(ft, staleId);
    const candidate: Candidate = { ...candidateWithoutAssessment, rawPageObject };
    const sourceManifest = manifest(ft, 1);
    const manifestObject = "raw/ft/runs/2026/08/31/run-ft-168h/manifest.json";
    const manifestPath = path.join(output, ...manifestObject.split("/"));
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(sourceManifest)}\n`);
    await writeFile(path.join(path.dirname(manifestPath), "candidates.jsonl.gz"), gzipSync(`${JSON.stringify(candidate)}\n`));
    const runManifestPath = path.join(output, "raw", "runs", "run-ft-168h.json");
    await mkdir(path.dirname(runManifestPath), { recursive: true });
    await writeFile(runManifestPath, `${JSON.stringify({
      runId: "run-ft-168h",
      sources: [{ sourceId: ft.id, status: "ok", output: { manifest: manifestObject } }],
    })}\n`);
    const args = (revision: string) => new Map([
      ["config", path.resolve("sources.v2.json")],
      ["output", output],
      ["run-manifest", runManifestPath],
      ["raw-revision", revision],
      ["translate", "false"],
    ]);
    const previousDay: TimesTimelineDay = {
      formatVersion: "jojo-news-timeline-day/1",
      date: ISSUE_DATE,
      updatedAt: "2026-08-30T00:00:00.000Z",
      articles: [previousDeliveryArticle(ft, staleId), previousDeliveryArticle(ft, keptId)],
    };
    const previousTimeline: TimesTimelineIndex = {
      formatVersion: "jojo-news-timeline-index/1",
      updatedAt: previousDay.updatedAt,
      dates: [{ date: ISSUE_DATE, object: `dates/2026/08/${ISSUE_DATE}.jox`, articleCount: 2 }],
      sources: [{ id: ft.id, name: ft.name, language: ft.language }],
    };

    const first = await runProcess(args("ft-v3-168h-replay"));
    expect(first.sources[0]?.skippedArticles).toEqual([
      expect.objectContaining({ articleId: staleId, reason: "stale-publisher-access-offer" }),
    ]);
    const canonicalDateObject = `canonical/ft/dates/2026/08/${ISSUE_DATE}.json.gz`;
    expect((await gzipJson<CanonicalDateIndex>(output, canonicalDateObject)).articles.map((row) => row.articleId)).toEqual([keptId]);
    await buildNewsDelivery({
      workspaceRoot: output,
      deliveryRoot,
      generatedAt: "2026-08-31T02:00:00.000Z",
      sources: [ft],
      process: first,
      previousTimelineIndex: previousTimeline,
      previousTimelineDays: new Map([[ISSUE_DATE, previousDay]]),
      previousSourceIndexes: new Map([[ft.id, previousSourceIndex(ft, [ISSUE_DATE])]]),
    });
    const dayObject = `content/timeline/dates/2026/08/${ISSUE_DATE}.jox`;
    const cleanDay = await joxJson<TimesTimelineDay>(deliveryRoot, dayObject);
    const cleanTimeline = await joxJson<TimesTimelineIndex>(deliveryRoot, "content/timeline/index.jox");
    const cleanSourceIndex = await joxJson<TimesSourceIndex>(deliveryRoot, "content/newspapers/ft/index.jox");
    expect(cleanDay.articles.map((row) => row.id)).toEqual([keptId]);

    const second = await runProcess(args("ft-v3-168h-replay-second"));
    expect(second.sources[0]).toMatchObject({
      dates: [],
      skippedArticles: [expect.objectContaining({ articleId: staleId, reason: "full-text-missing" })],
    });
    await buildNewsDelivery({
      workspaceRoot: output,
      deliveryRoot,
      generatedAt: "2026-08-31T02:10:00.000Z",
      sources: [ft],
      process: second,
      previousTimelineIndex: cleanTimeline,
      previousTimelineDays: new Map([[ISSUE_DATE, cleanDay]]),
      previousSourceIndexes: new Map([[ft.id, cleanSourceIndex]]),
    });
    expect((await joxJson<TimesTimelineDay>(deliveryRoot, dayObject)).articles.map((row) => row.id)).toEqual([keptId]);
    expect((await joxJson<TimesTimelineIndex>(deliveryRoot, "content/timeline/index.jox")).dates)
      .toEqual(cleanTimeline.dates);
    expect((await joxJson<TimesSourceIndex>(deliveryRoot, "content/newspapers/ft/index.jox")).items.map((item) => item.itemKey))
      .toEqual([ISSUE_DATE]);
    expect((await gzipJson<CanonicalDateIndex>(output, canonicalDateObject)).articles.map((row) => row.articleId)).toEqual([keptId]);
  });
});
