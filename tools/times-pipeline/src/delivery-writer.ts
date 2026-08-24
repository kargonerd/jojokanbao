import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  NEWS_TIMELINE_PROFILE,
  type JojoArticleDescriptor,
  type JojoCatalog,
  type JojoFragment,
  type NewsDateManifest,
  type NewsDeliveryArticle,
  type NewsPublisherIndex,
} from "@jojo/content";
import type { CanonicalArticle } from "./canonical-writer.js";
import { isCandidateAllowed, isCanonicalUrlAllowed } from "./candidate-policy.js";
import { sha256 } from "./identity.js";
import { plainText, removeParserArtifacts } from "./text.js";
import type { Candidate, SourceConfig } from "./types.js";

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
}

interface SourceDeliveryData {
  source: SourceConfig;
  candidates: Candidate[];
  canonical: CanonicalArticle[];
}

export interface NewsDeliverySourceResult {
  sourceId: string;
  indexObject: string;
  articles: number;
  items: number;
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

function timelineDate(value: string): string {
  const timestamp = new Date(value).valueOf();
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid article timestamp: ${value}`);
  return new Date(timestamp + 8 * 3_600_000).toISOString().slice(0, 10);
}

async function sourceData(
  workspaceRoot: string,
  source: SourceConfig,
  worker: RawWorkerResult | undefined,
  canonicalDates: string[],
  deliveryDates: ReadonlySet<string>,
  windowTo: string,
): Promise<SourceDeliveryData> {
  let rawCandidates: Candidate[] = [];
  if (worker?.output?.manifest) {
    const manifestPath = path.join(workspaceRoot, ...worker.output.manifest.split("/"));
    rawCandidates = await readJsonLinesGzip<Candidate>(path.join(path.dirname(manifestPath), "candidates.jsonl.gz"));
  }
  const candidates = rawCandidates.filter((candidate) => isCandidateAllowed(source, candidate));
  const canonicalById = new Map<string, CanonicalArticle>();
  const maximumPublishedAt = new Date(windowTo).valueOf();
  for (const date of canonicalDates) {
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
    for (const article of rows) {
      if (
        article.contentStatus !== "full"
        || article.source.id !== source.id
        || !isCanonicalUrlAllowed(source, article.canonicalUrl)
        || !deliveryDates.has(timelineDate(article.publishedAt))
        || new Date(article.publishedAt).valueOf() > maximumPublishedAt
      ) continue;
      canonicalById.set(article.articleId, article);
    }
  }
  return { source, candidates, canonical: [...canonicalById.values()] };
}

function articleSummary(candidate: Candidate | undefined, canonical: CanonicalArticle): string | undefined {
  const value = candidate?.summary || plainText(canonical.body.value);
  return value ? value.slice(0, 300) : undefined;
}

function sourceRef(source: SourceConfig) {
  return { id: source.id, name: source.name, language: source.language };
}

async function writeSourceDelivery(input: {
  deliveryRoot: string;
  generatedAt: string;
  data: SourceDeliveryData;
  previousIndex?: NewsPublisherIndex;
}): Promise<NewsDeliverySourceResult> {
  const { data } = input;
  const candidateById = new Map(data.candidates.map((candidate) => [candidate.articleId, candidate]));
  const byDate = new Map<string, CanonicalArticle[]>();
  for (const article of data.canonical) {
    const date = timelineDate(article.publishedAt);
    byDate.set(date, [...(byDate.get(date) ?? []), article]);
  }

  const currentItems: NewsPublisherIndex["items"] = [];
  const sortedDates = [...byDate.keys()].sort().reverse();
  for (const [dateIndex, date] of sortedDates.entries()) {
    const rows = (byDate.get(date) ?? []).sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
    const [year, month] = dateParts(date);
    const itemId = `${data.source.id}:${date}`;
    const itemPrefix = `content/newspapers/${data.source.id}/items/${year}/${month}/${date}`;
    const articles: NewsDeliveryArticle[] = [];
    const descriptors: JojoArticleDescriptor[] = [];

    for (const [articleIndex, canonical] of rows.entries()) {
      const body = {
        ...canonical.body,
        value: removeParserArtifacts(canonical.body.value).trim(),
      };
      const fragment: JojoFragment = {
        formatVersion: "jojo-fragment/1",
        itemId,
        fragmentId: canonical.articleId,
        type: "article",
        order: articleIndex + 1,
        title: canonical.title,
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
        id: canonical.articleId,
        order: articleIndex + 1,
        title: canonical.title,
        characterCount: plainText(body.value).length,
        status: "available",
        object: relativeObject,
        ...info,
      });
      const summary = articleSummary(candidateById.get(canonical.articleId), canonical);
      articles.push({
        id: canonical.articleId,
        title: canonical.title,
        ...(summary ? { summary } : {}),
        url: canonical.canonicalUrl,
        publishedAt: canonical.publishedAt,
        issueDate: date,
        language: canonical.language,
        source: sourceRef(data.source),
        authors: canonical.authors,
        categories: canonical.categories,
        publisherCategories: canonical.publisherCategories,
        articleObject,
      });
    }

    const manifestObject = `${itemPrefix}/manifest.jox`;
    const manifest: NewsDateManifest = {
      formatVersion: "jojo-item-manifest/1",
      revision: Date.parse(input.generatedAt),
      itemId,
      datasetId: data.source.id,
      type: "newspaper",
      title: `${data.source.name} · ${date}`,
      language: data.source.language,
      publicationStatus: "published",
      access: "authenticated",
      identifiers: { issueDate: date },
      metadata: {
        formatVersion: "jojo-news-date-metadata/1",
        issueDate: date,
        generatedAt: input.generatedAt,
        source: sourceRef(data.source),
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
    currentItems.push({
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

  const currentItemKeys = new Set(currentItems.map((item) => item.itemKey));
  const mergedItems = [
    ...currentItems,
    ...(input.previousIndex?.items ?? []).filter((item) => !currentItemKeys.has(item.itemKey)),
  ]
    .sort((left, right) => right.itemKey.localeCompare(left.itemKey))
    .map((item, index) => ({ ...item, order: index + 1 }));
  const indexObject = `content/newspapers/${data.source.id}/index.jox`;
  const index: NewsPublisherIndex = {
    formatVersion: "jojo-delivery-index/1",
    revision: Date.parse(input.generatedAt),
    datasetId: data.source.id,
    type: "newspaper",
    title: data.source.name,
    language: data.source.language,
    contentProfile: NEWS_TIMELINE_PROFILE,
    description: `${data.source.name}新闻时间线。`,
    publicationStatus: "published",
    access: "authenticated",
    items: mergedItems,
    updatedAt: input.generatedAt,
  };
  await writeJoxJson(input.deliveryRoot, indexObject, index);
  return { sourceId: data.source.id, indexObject, articles: data.canonical.length, items: mergedItems.length };
}

export async function buildNewsDelivery(input: {
  workspaceRoot: string;
  deliveryRoot: string;
  run: RawRunManifest;
  sources: SourceConfig[];
  windowHours: number;
  previousIndexes?: ReadonlyMap<string, NewsPublisherIndex>;
  previousCatalog?: JojoCatalog;
}): Promise<{
  articles: number;
  sources: NewsDeliverySourceResult[];
}> {
  const windowTo = input.run.completedAt;
  const windowFrom = new Date(new Date(input.run.startedAt).valueOf() - input.windowHours * 3_600_000).toISOString();
  const deliveryDateList = issueDatesBetween(
    `${timelineDate(windowFrom)}T00:00:00Z`,
    `${timelineDate(windowTo)}T00:00:00Z`,
  );
  const canonicalFrom = new Date(new Date(windowFrom).valueOf() - 24 * 3_600_000).toISOString();
  const canonicalDates = issueDatesBetween(canonicalFrom, windowTo);
  const deliveryDates = new Set(deliveryDateList);
  const workerBySource = new Map(input.run.sources.map((worker) => [worker.sourceId, worker]));
  const values = await Promise.all(input.sources.map((source) => sourceData(
    input.workspaceRoot,
    source,
    workerBySource.get(source.id),
    canonicalDates,
    deliveryDates,
    windowTo,
  )));
  const sourceResults = await Promise.all(values.map((data) => {
    const previousIndex = input.previousIndexes?.get(data.source.id);
    return writeSourceDelivery({
      deliveryRoot: input.deliveryRoot,
      generatedAt: input.run.completedAt,
      data,
      ...(previousIndex ? { previousIndex } : {}),
    });
  }));

  const sourceIds = new Set(input.sources.map((source) => source.id));
  const catalog: JojoCatalog = {
    formatVersion: "jojo-catalog/1",
    revision: Date.parse(input.run.completedAt),
    updatedAt: input.run.completedAt,
    datasets: [
      ...(input.previousCatalog?.datasets ?? []).filter((dataset) => (
        dataset.datasetId !== "times" && !sourceIds.has(dataset.datasetId)
      )),
      ...input.sources.map((source) => {
        const result = sourceResults.find((row) => row.sourceId === source.id);
        return {
          datasetId: source.id,
          type: "newspaper" as const,
          title: source.name,
          language: source.language,
          contentProfile: NEWS_TIMELINE_PROFILE,
          itemCount: result?.items ?? 0,
          indexObject: `content/newspapers/${source.id}/index.jox`,
          publicationStatus: "published" as const,
          access: "authenticated" as const,
        };
      }),
    ].sort((left, right) => left.title.localeCompare(right.title)),
  };
  await writeJoxJson(input.deliveryRoot, "catalog.jox", catalog);
  return {
    articles: sourceResults.reduce((sum, result) => sum + result.articles, 0),
    sources: sourceResults,
  };
}
