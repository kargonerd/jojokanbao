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
    captureBySource?: Array<{ sourceId: string; attempts: number; succeeded: number; failed: number }>;
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
  candidates: Candidate[];
  canonical: CanonicalArticle[];
  worker: RawWorkerResult;
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

async function sourceData(
  workspaceRoot: string,
  source: SourceConfig,
  worker: RawWorkerResult,
): Promise<SourceDeliveryData> {
  if (!worker.output?.manifest) return { source, candidates: [], canonical: [], worker };
  const manifestPath = path.join(workspaceRoot, ...worker.output.manifest.split("/"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SourceCaptureManifest;
  const candidates = await readJsonLinesGzip<Candidate>(path.join(path.dirname(manifestPath), "candidates.jsonl.gz"));
  const byDate = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const date = new Date(candidate.publishedAt).toISOString().slice(0, 10);
    const ids = byDate.get(date) ?? new Set<string>();
    ids.add(candidate.articleId);
    byDate.set(date, ids);
  }
  const canonical: CanonicalArticle[] = [];
  for (const [date, ids] of byDate) {
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
    canonical.push(...rows.filter((article) => ids.has(article.articleId)));
  }
  return { source, manifest, candidates, canonical, worker };
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
    .map((candidate) => ({
      id: candidate.articleId,
      source,
      reason: candidate.contentStatus === "metadata" ? "metadata-only" as const : "canonical-missing" as const,
      stage: candidate.contentStatus === "metadata" ? "capture" as const : "canonical" as const,
      message: candidate.contentStatus === "metadata"
        ? "已发现链接，但尚未取得可发布的正文或摘要。"
        : "Raw 候选存在，但本次 Canonical 没有对应文章。",
      title: candidate.title,
      url: candidate.canonicalUrl,
      publishedAt: candidate.publishedAt,
    }));
}

function sourceHealth(
  data: SourceDeliveryData,
  cases: TimesUnavailableCase[],
  browser = { attempts: 0, succeeded: 0, failed: 0 },
): TimesSourceHealth {
  const source = { id: data.source.id, name: data.source.name, language: data.source.language };
  const discovered = data.candidates.length;
  const full = data.canonical.filter((article) => article.contentStatus === "full").length;
  const summary = data.canonical.filter((article) => article.contentStatus === "summary").length;
  const delivered = full + summary;
  const unavailable = cases.length;
  const availabilityRate = discovered ? delivered / discovered : 0;
  const fullTextRate = discovered ? full / discovered : 0;
  const healthScore = discovered ? ((full + summary * 0.5) / discovered) * 100 : 0;
  return {
    source,
    status: delivered === 0 ? "unavailable" : unavailable > 0 || summary > 0 || browser.failed > 0 ? "degraded" : "healthy",
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
  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  const rows = await Promise.all(input.run.sources.map(async (worker) => {
    const source = sourceById.get(worker.sourceId);
    return source ? sourceData(input.workspaceRoot, source, worker) : undefined;
  }));
  const values = rows.filter((row): row is SourceDeliveryData => Boolean(row));
  const cases: TimesUnavailableCase[] = [];
  const health: TimesSourceHealth[] = [];
  const articleRows: Array<{ canonical: CanonicalArticle; candidate?: Candidate }> = [];
  const browserBySource = new Map((input.run.browserArchive?.captureBySource ?? []).map((row) => [row.sourceId, row]));

  for (const data of values) {
    const deliveredIds = new Set(data.canonical.map((article) => article.articleId));
    const sourceCases = unavailableCases(data, deliveredIds);
    cases.push(...sourceCases);
    health.push(sourceHealth(data, sourceCases, browserBySource.get(data.source.id)));
    const candidateById = new Map(data.candidates.map((candidate) => [candidate.articleId, candidate]));
    articleRows.push(...data.canonical.map((canonical) => {
      const candidate = candidateById.get(canonical.articleId);
      return candidate ? { canonical, candidate } : { canonical };
    }));
  }

  for (const failure of input.run.browserArchive?.failedCases ?? []) {
    const source = sourceById.get(failure.sourceId);
    if (!source) continue;
    const status = failure.httpStatus ? `HTTP ${failure.httpStatus}` : failure.error || "未取得主文档响应";
    cases.push({
      id: `${failure.articleId}:browser-capture`,
      source: { id: source.id, name: source.name, language: source.language },
      reason: "browser-capture-failed",
      stage: "capture",
      message: `Chromium 原页归档失败：${status}。文章摘要仍可独立发布时不会受此影响。`,
      ...(failure.title ? { title: failure.title } : {}),
      ...(failure.url ? { url: failure.url } : {}),
    });
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
        ...(row.canonical.publisherSections?.length ? { publisherSections: row.canonical.publisherSections } : {}),
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
  const to = input.run.completedAt;
  const from = new Date(new Date(input.run.startedAt).valueOf() - input.windowHours * 3_600_000).toISOString();
  const index: TimesDeliveryIndex = {
    formatVersion: "jojo-delivery-index/1",
    revision: Date.parse(input.run.completedAt),
    datasetId: "times",
    type: "newspaper",
    title: "JOJO 时事",
    language: "mul",
    description: "过去一天的跨媒体新闻与抓取健康审计。",
    aiEnabled: false,
    publicationStatus: "published",
    access: "authenticated",
    items: mergedItems,
    updatedAt: input.run.completedAt,
    window: { from, to, hours: input.windowHours },
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
    aiEnabled: false,
    publicationStatus: "published" as const,
    access: "authenticated" as const,
  };
  const catalog: JojoCatalog = {
    formatVersion: "jojo-catalog/1",
    revision: index.revision,
    updatedAt: index.updatedAt,
    datasets: [
      ...(input.previousCatalog?.datasets ?? [])
        .filter((dataset) => dataset.datasetId !== "times"),
      timesDataset,
    ],
  };
  await writeJoxJson(input.deliveryRoot, "catalog.jox", catalog);
  return { indexObject, articles: articleRows.length, sourceHealth: index.sourceHealth, unavailableCases: index.unavailableCases };
}
