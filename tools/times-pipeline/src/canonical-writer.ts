import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./identity.js";
import { removeParserArtifacts } from "./text.js";
import type { Candidate, PublisherSectionRef, SourceCaptureManifest, SourceConfig } from "./types.js";

export interface CanonicalArticle {
  formatVersion: "jojo-news-article/1";
  articleId: string;
  source: { id: string; name: string };
  canonicalUrl: string;
  title: string;
  authors: string[];
  language: string;
  publishedAt: string;
  updatedAt?: string;
  publisherCategories: string[];
  publisherSections?: PublisherSectionRef[];
  categories: string[];
  body: { format: "html" | "text"; profile?: "jojo-semantic-html/1"; value: string };
  contentStatus: "full" | "summary";
  contentHash: string;
  provenance: {
    rawRevision: string;
    rawRunId: string;
    rawManifest: string;
    discovery: SourceConfig["discovery"];
    parserVersion?: string;
    browserArchive?: string;
  };
}

type PublishableCandidate = Candidate & { contentStatus: "full" | "summary" };

function isPublishable(candidate: Candidate): candidate is PublishableCandidate {
  if (candidate.contentStatus === "metadata") return false;
  return Boolean(candidate.discoveryBody?.trim() || candidate.browserBody?.trim() || candidate.summary?.trim());
}

function issueDate(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function canonicalArticle(
  candidate: PublishableCandidate,
  manifest: SourceCaptureManifest,
  manifestObject: string,
  rawRevision: string,
  parserVersion?: string,
): CanonicalArticle {
  const fullBody = candidate.discoveryBody ?? candidate.browserBody;
  const value = removeParserArtifacts(fullBody ?? candidate.summary ?? "").trim();
  const body = fullBody
    ? { format: "html" as const, profile: "jojo-semantic-html/1" as const, value }
    : { format: "text" as const, value };
  const contentHash = sha256(JSON.stringify({
    title: candidate.title,
    publishedAt: candidate.publishedAt,
    body,
  }));
  return {
    formatVersion: "jojo-news-article/1",
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
    contentStatus: candidate.contentStatus,
    contentHash,
    provenance: {
      rawRevision,
      rawRunId: manifest.runId,
      rawManifest: manifestObject,
      discovery: manifest.discovery,
      ...(parserVersion ? { parserVersion } : {}),
      ...(candidate.browserArchiveObject ? { browserArchive: candidate.browserArchiveObject } : {}),
    },
  };
}

async function existingArticles(target: string): Promise<CanonicalArticle[]> {
  try {
    const body = gunzipSync(await readFile(target)).toString("utf8");
    return body.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as CanonicalArticle);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
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
): Promise<{ sourceId: string; dates: string[]; articles: number; skippedMetadata: number }> {
  const sourceRoot = path.join(output, "canonical", "news", source.id);
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "dataset.json"), `${JSON.stringify({
    formatVersion: "jojo-news-dataset/1",
    sourceId: source.id,
    title: source.name,
    language: source.language,
    itemPath: "articles/{YYYY}/{MM}/{YYYY-MM-DD}.jsonl.gz",
  }, null, 2)}\n`);
  const publishable = candidates.filter(isPublishable);
  const byDate = new Map<string, PublishableCandidate[]>();
  for (const candidate of publishable) {
    const date = issueDate(candidate.publishedAt);
    byDate.set(date, [...(byDate.get(date) ?? []), candidate]);
  }
  for (const [date, values] of byDate) {
    const [year, month] = date.split("-");
    if (!year || !month) continue;
    const target = path.join(sourceRoot, "articles", year, month, `${date}.jsonl.gz`);
    const merged = new Map((await existingArticles(target)).map((article) => [article.articleId, article]));
    for (const candidate of values) {
      merged.set(candidate.articleId, canonicalArticle(candidate, manifest, manifestObject, rawRevision, source.content.parser));
    }
    const rows = [...merged.values()].sort((left, right) => left.publishedAt.localeCompare(right.publishedAt) || left.articleId.localeCompare(right.articleId));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, gzipSync(rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { level: 9 }));
  }
  return {
    sourceId: source.id,
    dates: [...byDate.keys()].sort(),
    articles: publishable.length,
    skippedMetadata: candidates.length - publishable.length,
  };
}
