import { gunzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CapturedAsset } from "../types.js";
import type { ProcessedCandidate } from "./article.js";

interface ExistingDateIndex {
  articles?: Array<{ articleId?: unknown; object?: unknown }>;
}

interface ExistingCanonicalArticle {
  articleId?: unknown;
  body?: { value?: unknown };
  translations?: Record<string, unknown>;
  assets?: CapturedAsset[];
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

async function optionalGzipJson<T>(target: string): Promise<T | undefined> {
  try {
    return JSON.parse(gunzipSync(await readFile(target)).toString("utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function restoreUntranslatedUnchangedCandidates(
  output: string,
  candidates: readonly ProcessedCandidate[],
  targetLanguage = "zh-CN",
): Promise<ProcessedCandidate[]> {
  const dateIndexes = new Map<string, Promise<ExistingDateIndex | undefined>>();
  return Promise.all(candidates.map(async (candidate) => {
    if (candidate.captureStatus !== "unchanged" || candidate.processedBody || candidate.language.toLowerCase().startsWith("zh")) {
      return candidate;
    }
    const date = new Date(candidate.publishedAt);
    if (Number.isNaN(date.getTime())) return candidate;
    const dateValue = date.toISOString().slice(0, 10);
    const indexObject = `canonical/${candidate.sourceId}/dates/${dateValue.slice(0, 4)}/${dateValue.slice(5, 7)}/${dateValue}.json.gz`;
    const indexFile = localCanonicalPath(output, indexObject);
    let index = dateIndexes.get(indexFile);
    if (!index) {
      index = optionalGzipJson<ExistingDateIndex>(indexFile);
      dateIndexes.set(indexFile, index);
    }
    const articleObject = (await index)?.articles?.find((row) => row.articleId === candidate.articleId)?.object;
    if (typeof articleObject !== "string") return candidate;
    const expectedRoot = `canonical/${candidate.sourceId}/articles/`;
    const normalizedObject = articleObject.replaceAll("\\", "/");
    if (!normalizedObject.startsWith(expectedRoot) || !normalizedObject.endsWith(".json.gz")) {
      throw new Error(`Invalid Canonical article object for ${candidate.articleId}: ${articleObject}`);
    }
    const article = await optionalGzipJson<ExistingCanonicalArticle>(localCanonicalPath(output, normalizedObject));
    if (!article || article.articleId !== candidate.articleId || article.translations?.[targetLanguage]) return candidate;
    const body = article.body?.value;
    if (typeof body !== "string" || !body.trim()) return candidate;
    return {
      ...candidate,
      contentStatus: "full",
      processedBody: body,
      assets: article.assets ?? candidate.assets ?? [],
    };
  }));
}
