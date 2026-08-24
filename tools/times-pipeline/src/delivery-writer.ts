import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  JojoArticleDescriptor,
  JojoCatalog,
  JojoFragment,
  TimesDateManifest,
  TimesDeliveryArticle,
  TimesDeliveryIndex,
  TimesSourceHealth,
  TimesUnavailableCase,
} from "@jojo/content";
import type { CanonicalArticle } from "./canonical-writer.js";
import { isCandidateAllowed, isCanonicalUrlAllowed } from "./candidate-policy.js";
import { sha256 } from "./identity.js";
import { plainText, removeParserArtifacts } from "./text.js";
import type { Candidate, SourceCaptureManifest, SourceConfig } from "./types.js";

interface RawWorkerOutput {
  manifest?: string;
}

interface RawWorkerResult {
  sourceId: string;
  status: "ok" | "empty" | "error";
  error?: string;
  output?: RawWorkerOutput;
}

export interface RawRunManifest {
  runId: string;
  startedAt: string;
  completedAt: string;
  windowHours?: number;
  sources: RawWorkerResult[];
  browserArchive?: {
    captureBySource?: Array<{
      sourceId: string;
      attempts: number;
      succeeded: number;
      failed: number;
      extractedFullBodies?: number;
    }>;
    failedCases?: Array<{
      articleId: string;
      sourceId: string;
      title?: string;
      url?: string;
      httpStatus?: number | null;
      error?: string | null;
    }>;
  };
}

interface SourceDeliveryData {
  source: SourceConfig;
  manifest?: SourceCaptureManifest;
  rawCandidateCount: number;
  candidates: Candidate[];
  canonical: CanonicalArticle[];
  worker: RawWorkerResult;
}

interface BrowserSourceStats {
  attempts: number;
  succeeded: number;
  failed: number;
  extractedFullBodies?: number;
}

const JOX_SALT = 0x4a4f5831;

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function maskByte(position: number, objectSeed: number): number {
  let value = ((position >>> 0) + 0x9e3779b9) ^ objectSeed ^ JOX_SALT;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value & 0xff;
}

function transformJoxBytes(bytes: Uint8Array, objectKey: string): Uint8Array {
  const result = new Uint8Array(bytes.length);
  const seed = fnv1a(objectKey.replaceAll("\\", "/").replace(/^\/+/, ""));
  for (let index = 0; index < bytes.length; index += 1) {
    result[index] = bytes[index]! ^ maskByte(index, seed);
  }
  return result;
}

export function readJoxJson<T>(bytes: Uint8Array, objectKey: string): T {
  return JSON.parse(gunzipSync(transformJoxBytes(bytes, objectKey)).toString("utf8")) as T;
}

function roundedRate(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function dateParts(date: string): [string, string] {
  const [year, month] = date.split("-");
  if (!year || !month) throw new Error(`Invalid issue date: ${date}`);
  return [year, month];
}

async function writeJoxJson(root: string, objectKey: string, value: unknown): Promise<{ size: number; sha256: string }> {
  const clear = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const compressed = gzipSync(clear, { level: 9 });
  const target = path.join(root, ...objectKey.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, transformJoxBytes(compressed, objectKey));
  return { size: clear.length, sha256: sha256(clear) };
}

async function readJsonLinesGzip<T>(target: string): Promise<T[]> {
  try {
    return gunzipSync(await readFile(target)).toString("utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function issueDatesBetween(from: string, to: string): string[] {
  const start = new Date(from);
  const end = new Date(to);
  if (!Number.isFinite(start.valueOf()) || !Number.isFinite(end.valueOf()) || start > end) {
    throw new Error(`Invalid Delivery window: ${from} to ${to}`);
  }
  const dates: string[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cursor <= last) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

async function sourceData(
  workspaceRoot: string,
  source: SourceConfig,
  worker: RawWorkerResult,
  windowFrom: string,
  windowTo: string,
): Promise<SourceDeliveryData> {
  let manifest: SourceCaptureManifest | undefined;
  let rawCandidates: Candidate[] = [];
  if (worker.output?.manifest) {
    const manifestPath = path.join(workspaceRoot, ...worker.output.manifest.split("/"));
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SourceCaptureManifest;
    rawCandidates = await readJsonLinesGzip<Candidate>(path.join(path.dirname(manifestPath), "candidates.jsonl.gz"));
  }
  // Reapply the current source policy while building Delivery. Raw is immutable,
  // so an older run can still contain content (for example AP video pages) that
  // a newer source policy now skips entirely.
  const candidates = rawCandidates.filter((candidate) => isCandidateAllowed(source, candidate));
  // Canonical is cumulative. A feed can roll an article out between two
  // capture runs, so Delivery must read every shard in the active time window
  // instead of limiting itself to IDs repeated by the latest feed snapshot.
  const canonicalById = new Map<string, CanonicalArticle>();
  for (const date of issueDatesBetween(windowFrom, windowTo)) {
    const [year, month] = dateParts(date);
    const rows = await readJsonLinesGzip<CanonicalArticle>(path.join(
      workspaceRoot,
      "canonical",
      "news",
      source.id,
      "articles",
      year,
      month,
      `${date}.jsonl.gz`,
    ));
    // Delivery is full-text only. Keep this defensive filter even though the
    // Canonical writer also rejects summaries, so old Canonical shards cannot
    // leak summary-only articles back into the reader.
    for (const article of rows) {
      if (article.contentStatus !== "full") continue;
      const published = new Date(article.publishedAt).valueOf();
      if (published < new Date(windowFrom).valueOf() || published > new Date(windowTo).valueOf()) continue;
      canonicalById.set(article.articleId, article);
    }
  }
  const canonical = [...canonicalById.values()];
  return {
    source,
    ...(manifest ? { manifest } : {}),
    rawCandidateCount: rawCandidates.length,
    candidates,
    canonical,
    worker,
  };
}

function unavailableCases(data: SourceDeliveryData, deliveredIds: Set<string>): TimesUnavailableCase[] {
  const source = { id: data.source.id, name: data.source.name, language: data.source.language };
  if (data.worker.status === "error") {
    return [{
      id: `${data.source.id}:source-error`,
      source,
      reason: "source-error",
      stage: "discovery",
      message: data.worker.error || "来源任务执行失败，未生成 Raw manifest。",
    }];
  }
  if (data.candidates.length === 0) {
    // A source whose Raw candidates were all intentionally excluded (for
    // example, a video-only ChinaNews interval) is not a discovery failure.
    // `ok` also distinguishes this from a genuinely empty discovery worker:
    // current capture policy can exclude videos before they reach Raw.
    if (data.rawCandidateCount > 0 || data.worker.status === "ok") return [];
    return [{
      id: `${data.source.id}:source-empty`,
      source,
      reason: "source-empty",
      stage: "discovery",
      message: "过去一天没有发现可处理的文章。",
    }];
  }
  return data.candidates
    .filter((candidate) => !deliveredIds.has(candidate.articleId))
    .map((candidate) => {
      const reason = candidate.browserFailureReason === "hard-paywall"
        ? "hard-paywall" as const
        : candidate.browserFailureReason === "http-blocked"
          ? "http-blocked" as const
          : candidate.contentStatus === "metadata"
        ? "metadata-only" as const
        : candidate.contentStatus === "summary"
          ? "full-text-pending" as const
          : "canonical-missing" as const;
      return {
        id: candidate.articleId,
        source,
        reason,
        stage: reason === "canonical-missing" ? "canonical" as const : "capture" as const,
        message: reason === "hard-paywall"
          ? "原页为硬付费墙或只提供付费预览，按策略跳过。"
          : reason === "http-blocked"
            ? "原页被 HTTP 访问限制拦截，尚未取得全文。"
            : reason === "metadata-only"
          ? "已发现链接，但尚未取得正文。"
          : reason === "full-text-pending"
            ? "已发现文章摘要，但尚未取得全文，因此不进入 Delivery。"
            : "Raw 已有全文，但本次 Canonical 没有对应文章。",
        title: candidate.title,
        url: candidate.canonicalUrl,
        publishedAt: candidate.publishedAt,
      };
    });
}

function unavailableCaseArticleId(item: TimesUnavailableCase): string {
  return item.id.endsWith(":browser-capture")
    ? item.id.slice(0, -":browser-capture".length)
    : item.id;
}

function sourceHealth(
  data: SourceDeliveryData,
  cases: TimesUnavailableCase[],
  browser: BrowserSourceStats = { attempts: 0, succeeded: 0, failed: 0, extractedFullBodies: 0 },
): TimesSourceHealth {
  const source = { id: data.source.id, name: data.source.name, language: data.source.language };
  const deliveredIds = new Set(data.canonical
    .filter((article) => article.contentStatus === "full")
    .map((article) => article.articleId));
  const discoveredIds = new Set([
    ...data.candidates.map((candidate) => candidate.articleId),
    ...deliveredIds,
    ...cases.filter((item) => item.publishedAt).map((item) => item.id),
  ]);
  const discovered = discoveredIds.size;
  const full = deliveredIds.size;
  const summary = 0;
  const delivered = full;
  const unavailable = cases.length;
  const intentionallyEmpty = discovered === 0
    && (data.rawCandidateCount > 0 || data.worker.status === "ok")
    && unavailable === 0;
  const availabilityRate = discovered ? delivered / discovered : intentionallyEmpty ? 1 : 0;
  const fullTextRate = discovered ? full / discovered : intentionallyEmpty ? 1 : 0;
  const healthScore = discovered ? (full / discovered) * 100 : intentionallyEmpty ? 100 : 0;
  return {
    source,
    status: intentionallyEmpty ? "healthy" : delivered === 0 ? "unavailable" : unavailable > 0 ? "degraded" : "healthy",
    discovered,
    delivered,
    full,
    summary,
    unavailable,
    availabilityRate: roundedRate(availabilityRate),
    fullTextRate: roundedRate(fullTextRate),
    healthScore: Math.round(healthScore * 10) / 10,
    networkExchanges: data.manifest?.networkExchangeCount ?? 0,
    browserAttempts: browser.attempts,
    browserSucceeded: browser.succeeded,
    browserFailed: browser.failed,
    browserExtractedFull: browser.extractedFullBodies ?? 0,
    updatedAt: data.manifest?.completedAt ?? new Date().toISOString(),
  };
}

function articleSummary(candidate: Candidate | undefined, canonical: CanonicalArticle): string | undefined {
  const value = candidate?.summary || plainText(canonical.body.value);
  return value ? value.slice(0, 300) : undefined;
}

export async function buildTimesDelivery(input: {
  workspaceRoot: string;
  deliveryRoot: string;
  run: RawRunManifest;
  sources: SourceConfig[];
  windowHours: number;
  previousIndex?: TimesDeliveryIndex;
  previousCatalog?: JojoCatalog;
}): Promise<{
  indexObject: string;
  articles: number;
  sourceHealth: TimesSourceHealth[];
  unavailableCases: TimesUnavailableCase[];
}> {
  const windowTo = input.run.completedAt;
  const windowFrom = new Date(new Date(input.run.startedAt).valueOf() - input.windowHours * 3_600_000).toISOString();
  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  const workerBySource = new Map(input.run.sources.map((worker) => [worker.sourceId, worker]));
  // A targeted repair Raw run may contain only a subset of sources. Delivery
  // still represents the complete configured dataset and therefore always
  // reads cumulative Canonical for every enabled source.
  const values = await Promise.all(input.sources.map((source) => sourceData(
    input.workspaceRoot,
    source,
    workerBySource.get(source.id) ?? { sourceId: source.id, status: "ok" },
    windowFrom,
    windowTo,
  )));
  const cases: TimesUnavailableCase[] = [];
  const health: TimesSourceHealth[] = [];
  const articleRows: Array<{ canonical: CanonicalArticle; candidate?: Candidate }> = [];
  const deliveredIds = new Set<string>();
  const browserBySource = new Map((input.run.browserArchive?.captureBySource ?? []).map((row) => [row.sourceId, row]));

  for (const data of values) {
    const sourceDeliveredIds = new Set(data.canonical.map((article) => article.articleId));
    for (const articleId of sourceDeliveredIds) deliveredIds.add(articleId);
    const sourceCases = unavailableCases(data, sourceDeliveredIds);
    cases.push(...sourceCases);
    const candidateById = new Map(data.candidates.map((candidate) => [candidate.articleId, candidate]));
    articleRows.push(...data.canonical.map((canonical) => {
      const candidate = candidateById.get(canonical.articleId);
      return candidate ? { canonical, candidate } : { canonical };
    }));
  }

  const caseIds = new Set(cases.map((item) => item.id));
  for (const failure of input.run.browserArchive?.failedCases ?? []) {
    if (deliveredIds.has(failure.articleId) || caseIds.has(failure.articleId)) continue;
    const source = sourceById.get(failure.sourceId);
    if (!source) continue;
    if (failure.url && !isCanonicalUrlAllowed(source, failure.url)) continue;
    const status = failure.httpStatus ? `HTTP ${failure.httpStatus}` : failure.error || "未取得主文档响应";
    cases.push({
      id: `${failure.articleId}:browser-capture`,
      source: { id: source.id, name: source.name, language: source.language },
      reason: "browser-capture-failed",
      stage: "capture",
      message: `Chromium 原页归档失败：${status}。取得全文前不会进入 Delivery。`,
      ...(failure.title ? { title: failure.title } : {}),
      ...(failure.url ? { url: failure.url } : {}),
    });
  }

  // Preserve unresolved articles that have rolled out of a short feed but are
  // still inside this Delivery window. Resolved Canonical articles always win.
  const caseArticleIds = new Set(cases.map(unavailableCaseArticleId));
  for (const previous of input.previousIndex?.unavailableCases ?? []) {
    if (!previous.publishedAt || previous.publishedAt < windowFrom || previous.publishedAt > windowTo) continue;
    const articleId = unavailableCaseArticleId(previous);
    if (deliveredIds.has(articleId) || caseArticleIds.has(articleId)) continue;
    if (!sourceById.has(previous.source.id)) continue;
    cases.push(previous);
    caseIds.add(previous.id);
    caseArticleIds.add(articleId);
  }

  for (const data of values) {
    const sourceCases = cases.filter((item) => item.source.id === data.source.id);
    health.push(sourceHealth(data, sourceCases, browserBySource.get(data.source.id)));
  }

  articleRows.sort((left, right) => right.canonical.publishedAt.localeCompare(left.canonical.publishedAt));
  const byDate = new Map<string, Array<{ canonical: CanonicalArticle; candidate?: Candidate }>>();
  for (const row of articleRows) {
    const date = row.canonical.publishedAt.slice(0, 10);
    byDate.set(date, [...(byDate.get(date) ?? []), row]);
  }

  const itemSummaries: TimesDeliveryIndex["items"] = [];
  const sortedDates = [...byDate.keys()].sort().reverse();
  for (const [dateIndex, date] of sortedDates.entries()) {
    const rowsForDate = byDate.get(date) ?? [];
    const [year, month] = dateParts(date);
    const itemId = `times:${date}`;
    const itemPrefix = `content/newspapers/times/items/${year}/${month}/${date}`;
    const articles: TimesDeliveryArticle[] = [];
    const descriptors: JojoArticleDescriptor[] = [];

    for (const [articleIndex, row] of rowsForDate.entries()) {
      const body = {
        ...row.canonical.body,
        value: removeParserArtifacts(row.canonical.body.value).trim(),
      };
      const fragment: JojoFragment = {
        formatVersion: "jojo-fragment/1",
        itemId,
        fragmentId: row.canonical.articleId,
        type: "article",
        order: articleIndex + 1,
        title: row.canonical.title,
        body,
        assetRefs: [],
        annotations: [],
      };
      const clear = Buffer.from(`${JSON.stringify(fragment)}\n`, "utf8");
      const opaque = createHash("sha256").update(clear).digest("hex");
      const relativeObject = `articles/${opaque}.jox`;
      const articleObject = `${itemPrefix}/${relativeObject}`;
      const info = await writeJoxJson(input.deliveryRoot, articleObject, fragment);
      descriptors.push({
        id: row.canonical.articleId,
        order: articleIndex + 1,
        title: row.canonical.title,
        characterCount: plainText(body.value).length,
        status: "available",
        object: relativeObject,
        ...info,
      });
      const summary = articleSummary(row.candidate, row.canonical);
      articles.push({
        id: row.canonical.articleId,
        title: row.canonical.title,
        ...(summary ? { summary } : {}),
        contentStatus: row.canonical.contentStatus,
        url: row.canonical.canonicalUrl,
        publishedAt: row.canonical.publishedAt,
        issueDate: date,
        language: row.canonical.language,
        source: {
          id: row.canonical.source.id,
          name: row.canonical.source.name,
          language: row.canonical.language,
        },
        articleObject,
      });
    }

    const manifestObject = `${itemPrefix}/manifest.jox`;
    const manifest: TimesDateManifest = {
      formatVersion: "jojo-item-manifest/1",
      revision: Date.parse(input.run.completedAt),
      itemId,
      datasetId: "times",
      type: "newspaper",
      title: `时事 · ${date}`,
      language: "mul",
      publicationStatus: "published",
      access: "authenticated",
      identifiers: { issueDate: date },
      metadata: {
        formatVersion: "jojo-times-date-metadata/1",
        issueDate: date,
        generatedAt: input.run.completedAt,
        articles,
      },
      content: { schema: "jojo-content/newspaper/1", articles: descriptors },
      contentStats: {
        articleCount: articles.length,
        availableArticleCount: articles.length,
        missingArticleCount: 0,
        rejectedArticleCount: 0,
        characterCount: descriptors.reduce((sum, descriptor) => sum + descriptor.characterCount, 0),
      },
      assets: [],
      exports: [],
    };
    await writeJoxJson(input.deliveryRoot, manifestObject, manifest);
    itemSummaries.push({
      itemId,
      itemKey: date,
      type: "newspaper",
      order: dateIndex + 1,
      title: manifest.title,
      manifestObject: `items/${year}/${month}/${date}/manifest.jox`,
      publicationStatus: "published",
      access: "authenticated",
    });
  }

  const currentItemKeys = new Set(itemSummaries.map((item) => item.itemKey));
  const mergedItems = [
    ...itemSummaries,
    ...(input.previousIndex?.items ?? []).filter((item) => !currentItemKeys.has(item.itemKey)),
  ]
    .sort((left, right) => right.itemKey.localeCompare(left.itemKey))
    .map((item, index) => ({ ...item, order: index + 1 }));
  const indexObject = "content/newspapers/times/index.jox";
  const index: TimesDeliveryIndex = {
    formatVersion: "jojo-delivery-index/1",
    revision: Date.parse(input.run.completedAt),
    datasetId: "times",
    type: "newspaper",
    title: "JOJO 时事",
    language: "mul",
    description: "过去一天的跨媒体新闻与抓取健康审计。",
    publicationStatus: "published",
    access: "authenticated",
    items: mergedItems,
    updatedAt: input.run.completedAt,
    window: { from: windowFrom, to: windowTo, hours: input.windowHours },
    sourceHealth: health.sort((left, right) => left.source.name.localeCompare(right.source.name)),
    unavailableCases: cases.sort((left, right) => (right.publishedAt ?? "").localeCompare(left.publishedAt ?? "")),
  };
  await writeJoxJson(input.deliveryRoot, indexObject, index);

  const timesDataset = {
    datasetId: "times",
    type: "newspaper" as const,
    title: index.title,
    language: index.language,
    itemCount: mergedItems.length,
    indexObject,
    publicationStatus: "published" as const,
    access: "authenticated" as const,
  };
  const catalog: JojoCatalog = {
    formatVersion: "jojo-catalog/1",
    revision: index.revision,
    updatedAt: index.updatedAt,
    datasets: [
      ...(input.previousCatalog?.datasets ?? []).filter((dataset) => dataset.datasetId !== "times"),
      timesDataset,
    ],
  };
  await writeJoxJson(input.deliveryRoot, "catalog.jox", catalog);
  return { indexObject, articles: articleRows.length, sourceHealth: index.sourceHealth, unavailableCases: index.unavailableCases };
}
