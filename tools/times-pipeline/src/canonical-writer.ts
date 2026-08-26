import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import { sha256 } from "./identity.js";
import { removeParserArtifacts } from "./text.js";
import type { CapturedAsset, Candidate, PublisherSectionRef, SourceCaptureManifest, SourceConfig } from "./types.js";

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
  assets: CapturedAsset[];
  contentStatus: "full";
  contentHash: string;
  provenance: {
    rawRevision: string;
    rawRunId: string;
    rawManifest: string;
    rawPage?: string;
    discovery: SourceConfig["discovery"];
    parserVersion?: string;
    captureMethod?: "direct" | "browser";
  };
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
}

function bodyValue(candidate: Candidate): string | undefined {
  const value = candidate.capturedBody ?? candidate.discoveryBody;
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

function canonicalArticle(
  candidate: Candidate,
  value: string,
  manifest: SourceCaptureManifest,
  manifestObject: string,
  rawRevision: string,
  parserVersion?: string,
): CanonicalArticle {
  const body = { format: "html" as const, profile: "jojo-semantic-html/1" as const, value };
  const assets = candidate.assets ?? [];
  const contentHash = sha256(JSON.stringify({
    title: candidate.title,
    publishedAt: candidate.publishedAt,
    body,
    assets: assets.map((asset) => [asset.id, asset.sha256]),
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

export async function writeCanonicalSource(
  output: string,
  source: SourceConfig,
  manifest: SourceCaptureManifest,
  manifestObject: string,
  candidates: Candidate[],
  rawRevision: string,
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
  let skippedWithoutFullText = 0;
  for (const candidate of candidates) {
    const value = bodyValue(candidate);
    if (!value) {
      skippedWithoutFullText += 1;
      continue;
    }
    const article = canonicalArticle(candidate, value, manifest, manifestObject, rawRevision, source.content.parser);
    const object = `canonical/${source.id}/articles/${article.contentHash}.json.gz`;
    const target = path.join(output, ...object.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, gzipSync(`${JSON.stringify(article)}\n`, { level: 9 }));
    const ref = { articleId: article.articleId, object, contentHash: article.contentHash, publishedAt: article.publishedAt };
    created.push(ref);
    files.push(object);
    const date = new Date(article.publishedAt).toISOString().slice(0, 10);
    byDate.set(date, [...(byDate.get(date) ?? []), ref]);
  }

  for (const [date, refs] of byDate) {
    const [year, month] = date.split("-");
    if (!year || !month) continue;
    const object = `canonical/${source.id}/dates/${year}/${month}/${date}.json.gz`;
    const target = path.join(output, ...object.split("/"));
    const previous = await existingDate(target);
    const merged = new Map((previous?.articles ?? []).map((article) => [article.articleId, article]));
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
    dates: [...byDate.keys()].sort(),
    articles: created,
    files: [...new Set(files)],
    skippedWithoutFullText,
  };
}
