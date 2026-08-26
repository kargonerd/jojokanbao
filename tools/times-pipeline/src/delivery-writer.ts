import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import type {
  JojoArticleDescriptor,
  JojoAssetDescriptor,
  JojoCatalog,
  JojoFragment,
  TimesDateManifest,
  TimesDeliveryArticle,
  TimesSourceIndex,
  TimesTimelineDay,
  TimesTimelineIndex,
} from "@jojo/content";
import type { CanonicalArticle, CanonicalWriteResult } from "./canonical-writer.js";
import { sha256 } from "./identity.js";
import { plainText, removeParserArtifacts } from "./text.js";
import type { SourceConfig } from "./types.js";

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
  for (let index = 0; index < bytes.length; index += 1) result[index] = bytes[index]! ^ maskByte(index, seed);
  return result;
}

export function readJoxJson<T>(bytes: Uint8Array, objectKey: string): T {
  return JSON.parse(gunzipSync(transformJoxBytes(bytes, objectKey)).toString("utf8")) as T;
}

async function writeJoxJson(root: string, objectKey: string, value: unknown): Promise<{ size: number; sha256: string }> {
  const clear = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const target = path.join(root, ...objectKey.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, transformJoxBytes(gzipSync(clear, { level: 9 }), objectKey));
  return { size: clear.length, sha256: sha256(clear) };
}

async function writeJoxBytes(root: string, objectKey: string, clear: Uint8Array): Promise<void> {
  const target = path.join(root, ...objectKey.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, transformJoxBytes(clear, objectKey));
}

function dateParts(date: string): [string, string] {
  const [year, month] = date.split("-");
  if (!year || !month) throw new Error(`Invalid issue date: ${date}`);
  return [year, month];
}

async function canonicalArticles(workspaceRoot: string, process: { sources: CanonicalWriteResult[] }): Promise<CanonicalArticle[]> {
  const refs = process.sources.flatMap((source) => source.articles);
  return Promise.all(refs.map(async (ref) => JSON.parse(gunzipSync(
    await readFile(path.join(workspaceRoot, ...ref.object.split("/"))),
  ).toString("utf8")) as CanonicalArticle));
}

function bodyForDelivery(article: CanonicalArticle, availableAssets: ReadonlySet<string>): CanonicalArticle["body"] {
  const $ = load(removeParserArtifacts(article.body.value), undefined, false);
  $("figure[data-asset-id]").each((_index, element) => {
    const current = $(element);
    if (!availableAssets.has(current.attr("data-asset-id") ?? "")) current.remove();
  });
  return { ...article.body, value: $.html().trim() };
}

async function deliveryArticle(
  workspaceRoot: string,
  deliveryRoot: string,
  canonical: CanonicalArticle,
): Promise<{ article: TimesDeliveryArticle; descriptor: JojoArticleDescriptor; fragment: JojoFragment }> {
  const sourcePrefix = `content/newspapers/${canonical.source.id}`;
  const assets: JojoAssetDescriptor[] = [];
  for (const asset of canonical.assets) {
    try {
      const clear = new Uint8Array(await readFile(path.join(workspaceRoot, ...asset.rawObject.split("/"))));
      const object = `${sourcePrefix}/assets/${asset.sha256}.jox`;
      await writeJoxBytes(deliveryRoot, object, clear);
      assets.push({
        id: asset.id,
        type: "image",
        role: asset.role,
        mediaType: asset.mediaType,
        object,
        size: clear.byteLength,
        sha256: asset.sha256,
        ...(asset.alt ? { alt: asset.alt } : {}),
        ...(asset.caption ? { caption: asset.caption } : {}),
        ...(asset.width ? { width: asset.width } : {}),
        ...(asset.height ? { height: asset.height } : {}),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const body = bodyForDelivery(canonical, new Set(assets.map((asset) => asset.id)));
  const issueDate = canonical.publishedAt.slice(0, 10);
  const fragment: JojoFragment = {
    formatVersion: "jojo-fragment/1",
    itemId: `${canonical.source.id}:${issueDate}`,
    fragmentId: canonical.articleId,
    type: "article",
    order: 1,
    title: canonical.title,
    body,
    assetRefs: assets.map((asset) => asset.id),
    annotations: [],
  };
  const clear = Buffer.from(`${JSON.stringify(fragment)}\n`, "utf8");
  const opaque = createHash("sha256").update(clear).digest("hex");
  const articleObject = `${sourcePrefix}/articles/${opaque}.jox`;
  const info = await writeJoxJson(deliveryRoot, articleObject, fragment);
  const summary = plainText(body.value).slice(0, 300) || undefined;
  return {
    fragment,
    descriptor: {
      id: canonical.articleId,
      order: 1,
      title: canonical.title,
      characterCount: plainText(body.value).length,
      status: "available",
      object: articleObject,
      ...info,
    },
    article: {
      id: canonical.articleId,
      title: canonical.title,
      ...(summary ? { summary } : {}),
      contentStatus: "full",
      url: canonical.canonicalUrl,
      publishedAt: canonical.publishedAt,
      issueDate,
      language: canonical.language,
      source: { id: canonical.source.id, name: canonical.source.name, language: canonical.language },
      ...(canonical.publisherSections.length ? { publisherSections: canonical.publisherSections } : {}),
      articleObject,
      assets,
    },
  };
}

function mergeArticles(previous: readonly TimesDeliveryArticle[], current: readonly TimesDeliveryArticle[]): TimesDeliveryArticle[] {
  const merged = new Map(previous.map((article) => [article.id, article]));
  for (const article of current) merged.set(article.id, article);
  return [...merged.values()].sort((left, right) => right.publishedAt.localeCompare(left.publishedAt) || left.id.localeCompare(right.id));
}

export async function buildNewsDelivery(input: {
  workspaceRoot: string;
  deliveryRoot: string;
  generatedAt: string;
  sources: SourceConfig[];
  process: { sources: CanonicalWriteResult[] };
  previousTimelineIndex?: TimesTimelineIndex;
  previousTimelineDays?: ReadonlyMap<string, TimesTimelineDay>;
  previousSourceIndexes?: ReadonlyMap<string, TimesSourceIndex>;
  previousCatalog?: JojoCatalog;
}): Promise<{ timelineIndexObject: string; articles: number; sources: number; dates: string[] }> {
  const canonical = await canonicalArticles(input.workspaceRoot, input.process);
  const built = await Promise.all(canonical.map((article) => deliveryArticle(input.workspaceRoot, input.deliveryRoot, article)));
  const currentByDate = new Map<string, TimesDeliveryArticle[]>();
  const builtById = new Map(built.map((row) => [row.article.id, row]));
  for (const row of built) currentByDate.set(row.article.issueDate, [...(currentByDate.get(row.article.issueDate) ?? []), row.article]);

  const timelineRefs = new Map((input.previousTimelineIndex?.dates ?? []).map((date) => [date.date, date]));
  const mergedDays = new Map<string, TimesTimelineDay>();
  for (const [date, current] of currentByDate) {
    const articles = mergeArticles(input.previousTimelineDays?.get(date)?.articles ?? [], current);
    const object = `content/timeline/dates/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.jox`;
    const day: TimesTimelineDay = { formatVersion: "jojo-news-timeline-day/1", date, updatedAt: input.generatedAt, articles };
    await writeJoxJson(input.deliveryRoot, object, day);
    mergedDays.set(date, day);
    timelineRefs.set(date, { date, object: `dates/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.jox`, articleCount: articles.length });
  }

  const sourceItems = new Map<string, NonNullable<TimesSourceIndex["items"]>>();
  for (const source of input.sources) sourceItems.set(source.id, [...(input.previousSourceIndexes?.get(source.id)?.items ?? [])]);
  for (const [date, day] of mergedDays) {
    const [year, month] = dateParts(date);
    for (const source of input.sources) {
      const articles = day.articles.filter((article) => article.source.id === source.id);
      if (!articles.length) continue;
      const prefix = `content/newspapers/${source.id}`;
      const manifestObject = `${prefix}/dates/${year}/${month}/${date}.jox`;
      const descriptors = articles.map((article, index) => {
        const row = builtById.get(article.id);
        return row ? { ...row.descriptor, order: index + 1 } : {
          id: article.id,
          order: index + 1,
          title: article.title,
          characterCount: 0,
          status: "available" as const,
          object: article.articleObject,
        };
      });
      const assets = [...new Map(articles.flatMap((article) => article.assets).map((asset) => [asset.id, asset])).values()];
      const manifest: TimesDateManifest = {
        formatVersion: "jojo-item-manifest/1",
        revision: Date.parse(input.generatedAt),
        itemId: `${source.id}:${date}`,
        datasetId: `news-${source.id}`,
        type: "newspaper",
        title: `${source.name} · ${date}`,
        language: source.language,
        publicationStatus: "published",
        access: "authenticated",
        identifiers: { issueDate: date },
        metadata: {
          formatVersion: "jojo-news-source-date/1",
          issueDate: date,
          generatedAt: input.generatedAt,
          source: { id: source.id, name: source.name, language: source.language },
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
        assets,
        exports: [],
      };
      await writeJoxJson(input.deliveryRoot, manifestObject, manifest);
      const items = sourceItems.get(source.id) ?? [];
      const withoutDate = items.filter((item) => item.itemKey !== date);
      sourceItems.set(source.id, [{
        itemId: manifest.itemId,
        itemKey: date,
        type: "newspaper",
        order: 1,
        title: manifest.title,
        manifestObject: `dates/${year}/${month}/${date}.jox`,
        publicationStatus: "published",
        access: "authenticated",
      }, ...withoutDate]);
    }
  }

  for (const source of input.sources) {
    const items = (sourceItems.get(source.id) ?? []).sort((left, right) => right.itemKey.localeCompare(left.itemKey))
      .map((item, index) => ({ ...item, order: index + 1 }));
    const index: TimesSourceIndex = {
      formatVersion: "jojo-delivery-index/1",
      revision: Date.parse(input.generatedAt),
      datasetId: `news-${source.id}`,
      type: "newspaper",
      title: source.name,
      language: source.language,
      publicationStatus: "published",
      access: "authenticated",
      source: { id: source.id, name: source.name, language: source.language },
      items,
      updatedAt: input.generatedAt,
    };
    await writeJoxJson(input.deliveryRoot, `content/newspapers/${source.id}/index.jox`, index);
  }

  const timelineIndexObject = "content/timeline/index.jox";
  const timelineIndex: TimesTimelineIndex = {
    formatVersion: "jojo-news-timeline-index/1",
    updatedAt: input.generatedAt,
    dates: [...timelineRefs.values()].sort((left, right) => right.date.localeCompare(left.date)),
    sources: input.sources.map((source) => ({ id: source.id, name: source.name, language: source.language })),
  };
  await writeJoxJson(input.deliveryRoot, timelineIndexObject, timelineIndex);

  const sourceIds = new Set(input.sources.map((source) => `news-${source.id}`));
  const catalog: JojoCatalog = {
    formatVersion: "jojo-catalog/1",
    revision: Date.parse(input.generatedAt),
    updatedAt: input.generatedAt,
    datasets: [
      ...(input.previousCatalog?.datasets ?? []).filter((dataset) => !sourceIds.has(dataset.datasetId) && dataset.datasetId !== "times"),
      ...input.sources.map((source) => ({
        datasetId: `news-${source.id}`,
        type: "newspaper" as const,
        title: source.name,
        language: source.language,
        itemCount: sourceItems.get(source.id)?.length ?? 0,
        indexObject: `content/newspapers/${source.id}/index.jox`,
        publicationStatus: "published" as const,
        access: "authenticated" as const,
      })),
    ],
  };
  await writeJoxJson(input.deliveryRoot, "catalog.jox", catalog);
  return {
    timelineIndexObject,
    articles: built.length,
    sources: input.sources.length,
    dates: [...currentByDate.keys()].sort(),
  };
}
