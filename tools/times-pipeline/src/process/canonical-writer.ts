import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import { sha256 } from "../identity.js";
import { removeParserArtifacts } from "../text.js";
import type { StaleCanonicalBodyClassifier, StaleCanonicalRemovalReason } from "../sources/contracts.js";
import type { CapturedAsset, Candidate, PublisherSectionRef, SourceCaptureManifest, SourceConfig } from "../types.js";
import type { ProcessedCandidate } from "./article.js";

export interface CanonicalArticle {
  formatVersion: "jojo-news-article/2";
  articleId: string;
  source: { id: string; name: string };
  canonicalUrl: string;
  title: string;
  authors: string[];
  language: string;
  publishedAt: string;
  updatedAt?: string;
  publisherCategories: string[];
  publisherSections: PublisherSectionRef[];
  categories: string[];
  body: { format: "html"; profile: "jojo-semantic-html/1"; value: string };
  translations?: Record<string, CanonicalArticleTranslation>;
  assets: CapturedAsset[];
  contentStatus: "full";
  contentHash: string;
  provenance: {
    rawRevision: string;
    rawRunId: string;
    rawManifest: string;
    rawPage?: string;
    discovery: SourceCaptureManifest["discovery"];
    parserVersion?: string;
    captureMethod?: "direct" | "browser";
  };
}

export interface CanonicalArticleTranslation {
  language: "zh-CN";
  policy?: string;
  title: string;
  body: { format: "html"; profile: "jojo-semantic-html/1"; value: string };
  provider: "google-gemini-api";
  model: string;
  translatedAt: string;
  sourceHash: string;
  stale?: boolean;
}

export interface CanonicalArticleRef {
  articleId: string;
  object: string;
  contentHash: string;
  publishedAt: string;
}

export interface CanonicalDateIndex {
  formatVersion: "jojo-news-date/1";
  source: { id: string; name: string; language: string };
  issueDate: string;
  updatedAt: string;
  articles: CanonicalArticleRef[];
}

export interface CanonicalWriteResult {
  sourceId: string;
  dates: string[];
  articles: CanonicalArticleRef[];
  files: string[];
  skippedWithoutFullText: number;
  unchangedWithoutRefresh: number;
  unchangedArticles: Array<{
    articleId: string;
    title: string;
    canonicalUrl: string;
    publishedAt: string;
    contentStatus: Candidate["contentStatus"];
    captureStatus: "unchanged";
  }>;
  skippedArticles: Array<{
    articleId: string;
    title: string;
    canonicalUrl: string;
    publishedAt: string;
    reason: "hard-paywall" | "unsupported-media" | "duplicate-live-update" | "full-text-missing" | StaleCanonicalRemovalReason;
    contentStatus: Candidate["contentStatus"];
    captureStatus?: Candidate["captureStatus"];
    captureHttpStatus?: number;
  }>;
}

export interface CanonicalWriteOptions {
  classifyStaleCanonicalBody?: StaleCanonicalBodyClassifier;
}

function cleanedBody(value: string | undefined, candidate: ProcessedCandidate): string | undefined {
  if (!value?.trim() || candidate.contentStatus !== "full") return undefined;
  const $ = load(removeParserArtifacts(value), undefined, false);
  $("script,style,noscript,iframe,video,audio,picture,source").remove();
  $("img").remove();
  $("*").each((_index, element) => {
    const current = $(element);
    for (const attribute of Object.keys(current.attr() ?? {})) {
      const keep = (current.is("figure") && attribute === "data-asset-id")
        || (current.is("a") && attribute === "href");
      if (!keep) current.removeAttr(attribute);
    }
  });
  $("figure").each((_index, element) => {
    const current = $(element);
    const assetId = current.attr("data-asset-id");
    if (!assetId || !candidate.assets?.some((asset) => asset.id === assetId)) current.remove();
  });
  const cleaned = $.html().trim();
  return cleaned || undefined;
}

function bodyValue(candidate: ProcessedCandidate): string | undefined {
  return cleanedBody(candidate.processedBody, candidate);
}

function canonicalArticle(
  candidate: ProcessedCandidate,
  value: string,
  manifest: SourceCaptureManifest,
  manifestObject: string,
  rawRevision: string,
  parserVersion?: string,
): CanonicalArticle {
  const body = { format: "html" as const, profile: "jojo-semantic-html/1" as const, value };
  const assets = candidate.assets ?? [];
  const preserveAsStale = candidate.translationStatus === "failed" || candidate.translationStatus === "deferred";
  const previousTranslations = Object.fromEntries(Object.entries(candidate.previousTranslations ?? {}).flatMap(([language, translation]) => {
    const previousBody = cleanedBody(translation.body.value, candidate);
    if (!previousBody) return [];
    return [[language, {
      ...translation,
      body: { ...translation.body, value: previousBody },
      ...(preserveAsStale && language === "zh-CN" ? { stale: true } : translation.stale === true ? { stale: true } : {}),
    } satisfies CanonicalArticleTranslation]];
  }));
  const translatedBody = cleanedBody(candidate.translation?.body.value, candidate);
  const currentTranslation = candidate.translation && translatedBody ? {
    [candidate.translation.language]: {
      language: candidate.translation.language,
      ...(candidate.translation.policy ? { policy: candidate.translation.policy } : {}),
      title: candidate.translation.title,
      body: { ...candidate.translation.body, value: translatedBody },
      provider: candidate.translation.provider,
      model: candidate.translation.model,
      translatedAt: candidate.translation.translatedAt,
      sourceHash: candidate.translation.sourceHash,
    } satisfies CanonicalArticleTranslation,
  } : undefined;
  const translations = {
    ...previousTranslations,
    ...currentTranslation,
  };
  const hasTranslations = Object.keys(translations).length > 0;
  const contentHash = sha256(JSON.stringify({
    title: candidate.title,
    publishedAt: candidate.publishedAt,
    body,
    assets: assets.map((asset) => [asset.id, asset.sha256, asset.role, asset.afterBlock, asset.presentation]),
    translations: hasTranslations ? translations : undefined,
  }));
  return {
    formatVersion: "jojo-news-article/2",
    articleId: candidate.articleId,
    source: { id: candidate.sourceId, name: candidate.sourceName },
    canonicalUrl: candidate.canonicalUrl,
    title: candidate.title,
    authors: candidate.authors,
    language: candidate.language,
    publishedAt: candidate.publishedAt,
    ...(candidate.updatedAt ? { updatedAt: candidate.updatedAt } : {}),
    publisherCategories: candidate.publisherCategories,
    publisherSections: candidate.publisherSections ?? [],
    categories: [],
    body,
    ...(hasTranslations ? { translations } : {}),
    assets,
    contentStatus: "full",
    contentHash,
    provenance: {
      rawRevision,
      rawRunId: manifest.runId,
      rawManifest: manifestObject,
      ...(candidate.rawPageObject ? { rawPage: candidate.rawPageObject } : {}),
      discovery: manifest.discovery,
      ...(parserVersion ? { parserVersion } : {}),
      ...(candidate.captureMethod ? { captureMethod: candidate.captureMethod } : {}),
    },
  };
}

async function existingDate(target: string): Promise<CanonicalDateIndex | undefined> {
  try {
    return JSON.parse(gunzipSync(await readFile(target)).toString("utf8")) as CanonicalDateIndex;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function localCanonicalPath(output: string, objectName: string): string {
  const normalized = objectName.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe Canonical object path: ${objectName}`);
  }
  const root = path.resolve(output);
  const target = path.resolve(root, ...normalized.split("/"));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Unsafe Canonical object path: ${objectName}`);
  }
  return target;
}

async function previousCanonicalBody(
  output: string,
  source: SourceConfig,
  candidate: ProcessedCandidate,
): Promise<string | undefined> {
  const date = new Date(candidate.publishedAt).toISOString().slice(0, 10);
  const [year, month] = date.split("-");
  if (!year || !month) return undefined;
  const index = await existingDate(path.join(output, "canonical", source.id, "dates", year, month, `${date}.json.gz`));
  const object = index?.articles.find((article) => article.articleId === candidate.articleId)?.object;
  if (!object) return undefined;
  const normalized = object.replaceAll("\\", "/");
  const expectedRoot = `canonical/${source.id}/articles/`;
  if (!normalized.startsWith(expectedRoot) || !normalized.endsWith(".json.gz")) {
    throw new Error(`Invalid Canonical article object for ${candidate.articleId}: ${object}`);
  }
  try {
    const article = JSON.parse(gunzipSync(await readFile(localCanonicalPath(output, normalized))).toString("utf8")) as {
      articleId?: unknown;
      body?: { value?: unknown };
    };
    if (article.articleId !== candidate.articleId || typeof article.body?.value !== "string") return undefined;
    return article.body.value.trim() ? article.body.value : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function hasPublisherTruncatedAccessOffer(candidate: ProcessedCandidate): boolean {
  return candidate.bodyAssessment?.attempts.some((attempt) => (
    attempt.extractionPath === "publisher-extractor"
      && attempt.completeness === "truncated"
      && attempt.verdict === "rejected"
      && attempt.rejectReason === "publisher-truncated"
      && attempt.evidence?.kind === "access-offer"
  )) ?? false;
}

function missingBodyReason(candidate: ProcessedCandidate): CanonicalWriteResult["skippedArticles"][number]["reason"] {
  return candidate.captureStatus === "duplicate"
    ? "duplicate-live-update"
    : candidate.captureStatus === "hard-paywall"
      ? "hard-paywall"
      : candidate.captureStatus === "skipped"
        ? "unsupported-media"
        : "full-text-missing";
}

export async function writeCanonicalSource(
  output: string,
  source: SourceConfig,
  manifest: SourceCaptureManifest,
  manifestObject: string,
  candidates: ProcessedCandidate[],
  rawRevision: string,
  options: CanonicalWriteOptions = {},
): Promise<CanonicalWriteResult> {
  const sourceRoot = path.join(output, "canonical", source.id);
  await mkdir(sourceRoot, { recursive: true });
  const datasetObject = `canonical/${source.id}/dataset.json`;
  await writeFile(path.join(output, ...datasetObject.split("/")), `${JSON.stringify({
    formatVersion: "jojo-news-dataset/2",
    sourceId: source.id,
    title: source.name,
    language: source.language,
    articlePath: "articles/{contentHash}.json.gz",
    datePath: "dates/{YYYY}/{MM}/{YYYY-MM-DD}.json.gz",
  }, null, 2)}\n`);

  const created: CanonicalArticleRef[] = [];
  const files = [datasetObject];
  const byDate = new Map<string, CanonicalArticleRef[]>();
  const removedByDate = new Map<string, Set<string>>();
  const skippedArticles: CanonicalWriteResult["skippedArticles"] = [];
  const unchangedArticles: CanonicalWriteResult["unchangedArticles"] = [];
  for (const candidate of candidates) {
    const value = bodyValue(candidate);
    if (!value) {
      if (candidate.captureStatus === "unchanged") {
        unchangedArticles.push({
          articleId: candidate.articleId,
          title: candidate.title,
          canonicalUrl: candidate.canonicalUrl,
          publishedAt: candidate.publishedAt,
          contentStatus: candidate.contentStatus,
          captureStatus: "unchanged",
        });
        continue;
      }
      let reason = missingBodyReason(candidate);
      if (reason === "full-text-missing"
        && options.classifyStaleCanonicalBody
        && hasPublisherTruncatedAccessOffer(candidate)) {
        const previousBody = await previousCanonicalBody(output, source, candidate);
        const classified = previousBody ? options.classifyStaleCanonicalBody(previousBody) : undefined;
        if (classified) reason = classified;
      }
      skippedArticles.push({
        articleId: candidate.articleId,
        title: candidate.title,
        canonicalUrl: candidate.canonicalUrl,
        publishedAt: candidate.publishedAt,
        reason,
        contentStatus: candidate.contentStatus,
        ...(candidate.captureStatus ? { captureStatus: candidate.captureStatus } : {}),
        ...(candidate.captureHttpStatus !== undefined ? { captureHttpStatus: candidate.captureHttpStatus } : {}),
      });
      if (reason === "unsupported-media" || reason === "duplicate-live-update" || reason === "stale-publisher-access-offer") {
        const date = new Date(candidate.publishedAt).toISOString().slice(0, 10);
        removedByDate.set(date, new Set([...(removedByDate.get(date) ?? []), candidate.articleId]));
      }
      continue;
    }
    const article = canonicalArticle(
      candidate,
      value,
      manifest,
      manifestObject,
      rawRevision,
      candidate.parserVersion ?? source.content.parser,
    );
    const object = `canonical/${source.id}/articles/${article.contentHash}.json.gz`;
    const target = path.join(output, ...object.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, gzipSync(`${JSON.stringify(article)}\n`, { level: 9 }));
    const ref = { articleId: article.articleId, object, contentHash: article.contentHash, publishedAt: article.publishedAt };
    created.push(ref);
    files.push(object);
    if (candidate.translationCacheObject) files.push(candidate.translationCacheObject);
    const date = new Date(article.publishedAt).toISOString().slice(0, 10);
    byDate.set(date, [...(byDate.get(date) ?? []), ref]);
  }

  const affectedDates = new Set([...byDate.keys(), ...removedByDate.keys()]);
  for (const date of affectedDates) {
    const refs = byDate.get(date) ?? [];
    const [year, month] = date.split("-");
    if (!year || !month) continue;
    const object = `canonical/${source.id}/dates/${year}/${month}/${date}.json.gz`;
    const target = path.join(output, ...object.split("/"));
    const previous = await existingDate(target);
    const removed = removedByDate.get(date) ?? new Set<string>();
    const merged = new Map((previous?.articles ?? [])
      .filter((article) => !removed.has(article.articleId))
      .map((article) => [article.articleId, article]));
    for (const ref of refs) merged.set(ref.articleId, ref);
    const dateIndex: CanonicalDateIndex = {
      formatVersion: "jojo-news-date/1",
      source: { id: source.id, name: source.name, language: source.language },
      issueDate: date,
      updatedAt: new Date().toISOString(),
      articles: [...merged.values()].sort((left, right) => right.publishedAt.localeCompare(left.publishedAt)),
    };
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, gzipSync(`${JSON.stringify(dateIndex)}\n`, { level: 9 }));
    files.push(object);
  }
  return {
    sourceId: source.id,
    dates: [...affectedDates].sort(),
    articles: created,
    files: [...new Set(files)],
    skippedWithoutFullText: skippedArticles.length,
    unchangedWithoutRefresh: unchangedArticles.length,
    unchangedArticles,
    skippedArticles,
  };
}
