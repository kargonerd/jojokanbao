import { gunzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import { bodyQuality, selectArticleBody, type ArticleBodyExtractor } from "../content/body.js";
import type { CapturedAsset, Candidate, SourceConfig, SourceFetchPolicy } from "../types.js";

interface RawPageMetadata {
  formatVersion?: unknown;
  finalUrl?: unknown;
  renderedHtml?: unknown;
}

interface RenderedPage {
  html: string;
  finalUrl?: string;
}

export interface ProcessedCandidate extends Candidate {
  processedBody?: string;
  parserVersion?: string;
  translation?: ProcessedArticleTranslation;
  previousTranslations?: Record<string, ProcessedArticleTranslation>;
  translationCacheObject?: string;
  translationStatus?: "translated" | "cached" | "failed" | "deferred";
  translationError?: string;
}

export interface ProcessedArticleTranslation {
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

function localObjectPath(output: string, objectName: string): string {
  const normalized = objectName.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe Raw object path: ${objectName}`);
  }
  const root = path.resolve(output);
  const resolved = path.resolve(root, ...normalized.split("/"));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Unsafe Raw object path: ${objectName}`);
  }
  return resolved;
}

function rawPagePart(metadataObject: string, relativeObject: string): string {
  const normalized = relativeObject.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe Raw page part: ${relativeObject}`);
  }
  return path.posix.join(path.posix.dirname(metadataObject), normalized);
}

async function renderedPage(output: string, candidate: Candidate): Promise<RenderedPage | undefined> {
  if (!candidate.rawPageObject) return undefined;
  const metadata = JSON.parse(await readFile(localObjectPath(output, candidate.rawPageObject), "utf8")) as RawPageMetadata;
  if (metadata.formatVersion !== "jojo-raw-page/1") {
    throw new Error(`${candidate.articleId}: unsupported Raw page metadata`);
  }
  if (metadata.renderedHtml === null || metadata.renderedHtml === undefined) return undefined;
  if (typeof metadata.renderedHtml !== "string") {
    throw new Error(`${candidate.articleId}: invalid renderedHtml object`);
  }
  const objectName = rawPagePart(candidate.rawPageObject, metadata.renderedHtml);
  return {
    html: gunzipSync(await readFile(localObjectPath(output, objectName))).toString("utf8"),
    ...(typeof metadata.finalUrl === "string" ? { finalUrl: metadata.finalUrl } : {}),
  };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function attachAssetsToBody(body: string, assets: readonly CapturedAsset[]): string {
  const figure = (asset: CapturedAsset) => `<figure data-asset-id="${escapeHtml(asset.id)}">${asset.caption ? `<figcaption>${escapeHtml(asset.caption)}</figcaption>` : ""}</figure>`;
  const lead = assets.filter((asset) => asset.role === "lead");
  const content = assets.filter((asset) => asset.role !== "lead");
  const positioned = new Map<number, CapturedAsset[]>();
  const trailing: CapturedAsset[] = [];
  for (const asset of content) {
    if (asset.afterBlock === undefined) trailing.push(asset);
    else positioned.set(asset.afterBlock, [...(positioned.get(asset.afterBlock) ?? []), asset]);
  }
  const document = load(body, undefined, false);
  const blocks = new Set(["blockquote", "h2", "h3", "h4", "ol", "p", "pre", "ul"]);
  let blockIndex = 0;
  let value = `${lead.map(figure).join("")}${(positioned.get(0) ?? []).map(figure).join("")}`;
  for (const element of document.root().children().toArray()) {
    value += document.html(element);
    if (blocks.has(element.tagName.toLowerCase())) {
      blockIndex += 1;
      value += (positioned.get(blockIndex) ?? []).map(figure).join("");
    }
  }
  const overflow = [...positioned.entries()]
    .filter(([index]) => index > blockIndex)
    .flatMap(([, values]) => values);
  return `${value}${[...overflow, ...trailing].map(figure).join("")}`;
}

export async function processArticle(
  output: string,
  source: SourceConfig,
  candidate: Candidate,
  fetchPolicy?: SourceFetchPolicy,
  sourceExtractor?: ArticleBodyExtractor,
): Promise<ProcessedCandidate> {
  if (["unchanged", "skipped", "hard-paywall", "duplicate"].includes(candidate.captureStatus ?? "")) {
    return { ...candidate };
  }
  const page = await renderedPage(output, candidate);
  const quality = bodyQuality(source);
  const selection = selectArticleBody({
    ...(page ? { capturedPage: { html: page.html, pageUrl: page.finalUrl ?? candidate.canonicalUrl } } : {}),
    ...(candidate.discoveryBody ? { discoveryBody: { html: candidate.discoveryBody, pageUrl: candidate.canonicalUrl } } : {}),
  }, fetchPolicy, quality, sourceExtractor);
  return {
    ...candidate,
    bodyAssessment: selection.report,
    ...(selection.body ? {
      contentStatus: "full" as const,
      processedBody: attachAssetsToBody(selection.body, candidate.assets ?? []),
    } : {}),
  };
}
