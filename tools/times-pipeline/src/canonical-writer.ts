import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./identity.js";
import { removeParserArtifacts } from "./text.js";
import type { Candidate, SourceCaptureManifest, SourceConfig } from "./types.js";

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

type FullCandidate = Candidate & { contentStatus: "full" };

function isFull(candidate: Candidate): candidate is FullCandidate {
  return candidate.contentStatus === "full"
    && Boolean(candidate.discoveryBody?.trim() || candidate.browserBody?.trim());
}

function issueDate(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function canonicalArticle(
  candidate: FullCandidate,
  manifest: SourceCaptureManifest,
  manifestObject: string,
  rawRevision: string,
  parserVersion?: string,
): CanonicalArticle {
  const fullBody = candidate.discoveryBody ?? candidate.browserBody;
  if (!fullBody?.trim()) throw new Error(`${candidate.articleId}: full candidate has no full body`);
  const value = removeParserArtifacts(fullBody).trim();
  const body = { format: "html" as const, profile: "jojo-semantic-html/1" as const, value };
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
): Promise<{ sourceId: string; dates: string[]; articles: number; skippedMetadata: number; skippedNonFull: number }> {
  const sourceRoot = path.join(output, "canonical", "news", source.id);
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "dataset.json"), `${JSON.stringify({
    formatVersion: "jojo-news-dataset/1",
    sourceId: source.id,
    title: source.name,
    language: source.language,
    itemPath: "articles/{YYYY}/{MM}/{YYYY-MM-DD}.jsonl.gz",
  }, null, 2)}\n`);
  const fullCandidates = candidates.filter(isFull);
  const byDate = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const date = issueDate(candidate.publishedAt);
    byDate.set(date, [...(byDate.get(date) ?? []), candidate]);
  }
  for (const [date, values] of byDate) {
    const [year, month] = date.split("-");
    if (!year || !month) continue;
    const target = path.join(sourceRoot, "articles", year, month, `${date}.jsonl.gz`);
    // Canonical is a full-text layer. Historical summaries are removed, while a
    // previously captured full article is never replaced by a later feed-only
    // observation of the same URL.
    const merged = new Map((await existingArticles(target))
      .filter((article) => article.contentStatus === "full")
      .map((article) => [article.articleId, article]));
    for (const candidate of values.filter(isFull)) {
      merged.set(candidate.articleId, canonicalArticle(candidate, manifest, manifestObject, rawRevision, source.content.parser));
    }
    const rows = [...merged.values()].sort((left, right) => left.publishedAt.localeCompare(right.publishedAt) || left.articleId.localeCompare(right.articleId));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, gzipSync(rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { level: 9 }));
  }
  return {
    sourceId: source.id,
    dates: [...byDate.keys()].sort(),
    articles: fullCandidates.length,
    skippedMetadata: candidates.filter((candidate) => candidate.contentStatus === "metadata").length,
    skippedNonFull: candidates.length - fullCandidates.length,
  };
}
