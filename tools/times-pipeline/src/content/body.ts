import { load } from "cheerio";
import type { SourceConfig, SourceFetchPolicy } from "../types.js";
import { semanticParagraphs, type BodyQuality } from "./paragraphs.js";

type JsonObject = Record<string, unknown>;

export type ArticleBodyExtractor = (html: string, quality: BodyQuality) => string | undefined;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function articleBodies(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(articleBodies);
  const row = object(value);
  if (!row) return [];
  return [
    ...(typeof row.articleBody === "string" ? [row.articleBody] : []),
    ...Object.values(row).flatMap(articleBodies),
  ];
}

export function bodyQuality(source: SourceConfig): BodyQuality {
  return {
    ...(source.content.minimumFullCharacters !== undefined ? { minimumCharacters: source.content.minimumFullCharacters } : {}),
    ...(source.content.minimumFullParagraphs !== undefined ? { minimumParagraphs: source.content.minimumFullParagraphs } : {}),
  };
}

export function extractArticleBody(
  html: string,
  policy?: SourceFetchPolicy,
  quality: BodyQuality = {},
  sourceExtractor?: ArticleBodyExtractor,
): string | undefined {
  if (!html.trim()) return undefined;
  const sourceBody = sourceExtractor?.(html, quality);
  if (sourceBody) return sourceBody;
  const document = load(html);
  const jsonBodies: string[] = [];
  document('script[type="application/ld+json"]').each((_, element) => {
    try {
      jsonBodies.push(...articleBodies(JSON.parse(document(element).text())));
    } catch {
      // Continue with source-owned DOM selectors.
    }
  });
  const jsonBody = jsonBodies.toSorted((left, right) => right.length - left.length)[0];
  if (jsonBody && jsonBody.length >= (quality.minimumCharacters ?? 800)) {
    const result = semanticParagraphs(jsonBody.split(/\r?\n(?:\s*\r?\n)*/u), quality);
    if (result) return result;
  }
  document("script, style, nav, footer, header, aside, form, noscript").remove();
  const sourceSelectors = policy?.bodySelectors ?? [];
  const genericSelectors = [
    "[itemprop='articleBody']",
    "article",
    ".article-body",
    ".article__body",
    ".story-body",
    ".storytext",
    ".entry-content",
    ".post-content",
    "main",
  ];
  const bestBody = (selectors: readonly string[], completeContainerFallback: boolean): string | undefined => {
    let best: string | undefined;
    for (const selector of selectors) {
      const values: string[] = [];
      document(selector).each((_, container) => {
        const elements = document(container).find("p, h2, h3, blockquote").toArray();
        if (elements.length) values.push(...elements.map((element) => document(element).text()));
        else values.push(document(container).text());
      });
      let candidate = semanticParagraphs(values, quality);
      if (!candidate && completeContainerFallback) {
        const completeContainers = document(selector).toArray().map((container) => document(container).text());
        candidate = semanticParagraphs(completeContainers, quality);
      }
      if (candidate && (!best || candidate.length > best.length)) best = candidate;
    }
    return best;
  };
  return bestBody(sourceSelectors, true) ?? bestBody(genericSelectors, false);
}

export function hasArticleBody(
  html: string,
  policy?: SourceFetchPolicy,
  quality: BodyQuality = {},
  sourceExtractor?: ArticleBodyExtractor,
): boolean {
  return Boolean(extractArticleBody(html, policy, quality, sourceExtractor));
}
