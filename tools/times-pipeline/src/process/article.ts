import { gunzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { bodyQuality, extractArticleBody, type ArticleBodyExtractor } from "../content/body.js";
import type { CapturedAsset, Candidate, SourceConfig, SourceFetchPolicy } from "../types.js";

interface RawPageMetadata {
  formatVersion?: unknown;
  renderedHtml?: unknown;
}

export interface ProcessedCandidate extends Candidate {
  processedBody?: string;
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

async function renderedPageHtml(output: string, candidate: Candidate): Promise<string | undefined> {
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
  return gunzipSync(await readFile(localObjectPath(output, objectName))).toString("utf8");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function attachAssetsToBody(body: string, assets: readonly CapturedAsset[]): string {
  const figures = assets.map((asset) => `<figure data-asset-id="${escapeHtml(asset.id)}">${asset.caption ? `<figcaption>${escapeHtml(asset.caption)}</figcaption>` : ""}</figure>`);
  const lead = assets.findIndex((asset) => asset.role === "lead");
  if (lead < 0) return `${body}${figures.join("")}`;
  const [leadFigure] = figures.splice(lead, 1);
  return `${leadFigure ?? ""}${body}${figures.join("")}`;
}

export async function processArticle(
  output: string,
  source: SourceConfig,
  candidate: Candidate,
  fetchPolicy?: SourceFetchPolicy,
  sourceExtractor?: ArticleBodyExtractor,
): Promise<ProcessedCandidate> {
  if (candidate.captureStatus === "skipped" || candidate.captureStatus === "hard-paywall") {
    return { ...candidate };
  }
  const renderedHtml = await renderedPageHtml(output, candidate);
  const quality = bodyQuality(source);
  const pageBody = renderedHtml
    ? extractArticleBody(renderedHtml, fetchPolicy, quality, sourceExtractor)
    : undefined;
  const discoveryBody = !pageBody && candidate.discoveryBody
    ? extractArticleBody(candidate.discoveryBody, fetchPolicy, quality, sourceExtractor)
    : undefined;
  const body = pageBody ?? discoveryBody;
  return {
    ...candidate,
    ...(body ? {
      contentStatus: "full" as const,
      processedBody: attachAssetsToBody(body, candidate.assets ?? []),
    } : {}),
  };
}
