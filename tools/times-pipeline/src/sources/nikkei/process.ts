import { load } from "cheerio";
import { semanticParagraphs, type BodyQuality } from "../../content/paragraphs.js";
import type { Candidate } from "../../types.js";

type JsonObject = Record<string, unknown>;

function newsArticleAccess(value: unknown): boolean | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const access = newsArticleAccess(item);
      if (access !== undefined) return access;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const row = value as JsonObject;
  const types = Array.isArray(row["@type"]) ? row["@type"] : [row["@type"]];
  const newsArticle = types.some((type) => typeof type === "string" && type.toLowerCase() === "newsarticle");
  if (newsArticle && (typeof row.isAccessibleForFree === "boolean" || typeof row.isAccessibleForFree === "string")) {
    return row.isAccessibleForFree === true || row.isAccessibleForFree === "true";
  }
  for (const child of Object.values(row)) {
    const access = newsArticleAccess(child);
    if (access !== undefined) return access;
  }
  return undefined;
}

export function nikkeiArticleAccess(html: string): boolean | undefined {
  const document = load(html);
  let access: boolean | undefined;
  document('script[type="application/ld+json"]').each((_, element) => {
    if (access !== undefined) return;
    try {
      access = newsArticleAccess(JSON.parse(document(element).text()));
    } catch {
      // Continue past malformed optional metadata.
    }
  });
  return access;
}

export function extractNikkeiFreeArticleBody(html: string, quality: BodyQuality): string | undefined {
  const document = load(html);
  if (nikkeiArticleAccess(html) !== true) return undefined;
  const selector = [
    "[class*='ArticleBodyWithTracking_articleBodyWithTracking']",
    "[class*='FeatureArticleBody_featureArticleBody']",
    "[id^='article-body']",
    "[itemprop='articleBody']",
  ].join(", ");
  const values = document(selector).first().find("p, h2, h3, blockquote").toArray()
    .map((element) => document(element).text());
  return semanticParagraphs(values, {
    minimumCharacters: Math.min(quality.minimumCharacters ?? 300, 300),
    minimumParagraphs: Math.min(quality.minimumParagraphs ?? 3, 3),
  });
}

export function processNikkei(candidate: Candidate): Candidate {
  return { ...candidate, publisherCategories: [...new Set(candidate.publisherCategories)] };
}
