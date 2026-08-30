import { load } from "cheerio";
import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";
import type { Candidate } from "../../types.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

export function nikkeiPageData(html: string): JsonObject | undefined {
  const document = load(html);
  const script = document("#__NEXT_DATA__").text();
  if (!script) return undefined;
  try {
    return object(object(object(JSON.parse(script))?.props)?.pageProps)?.data as JsonObject | undefined;
  } catch {
    return undefined;
  }
}

function escaped(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

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

export function extractNikkeiFreeArticleBody(html: string, quality: BodyQuality, pageUrl?: string): string | undefined {
  const document = load(html);
  if (nikkeiArticleAccess(html) !== true) return undefined;
  const pageData = nikkeiPageData(html);
  const embeddedBody = typeof pageData?.body === "string" ? pageData.body : undefined;
  if (embeddedBody) {
    const body = load(embeddedBody, undefined, false);
    const blocks = body("p,h2,h3,h4,blockquote,ul,ol,pre").toArray()
      .filter((element) => !body(element).parents("p,h2,h3,h4,blockquote,ul,ol,pre").length)
      .map((element) => body.html(element));
    const subhead = typeof pageData?.subhead === "string" && pageData.subhead.trim()
      ? `<p><strong>${escaped(pageData.subhead.trim())}</strong></p>`
      : undefined;
    const extracted = semanticHtmlBlocks(subhead ? [subhead, ...blocks] : blocks, {
      minimumCharacters: Math.min(quality.minimumCharacters ?? 300, 300),
      minimumParagraphs: Math.min(quality.minimumParagraphs ?? 3, 3),
    }, pageUrl);
    if (extracted) return extracted;
  }
  const selector = [
    "[class*='ArticleBodyWithTracking_articleBodyWithTracking']",
    "[class*='FeatureArticleBody_featureArticleBody']",
    "[id^='article-body']",
    "[itemprop='articleBody']",
  ].join(", ");
  const values = document(selector).first().find("p,h2,h3,h4,blockquote,ul,ol,pre").toArray()
    .filter((element) => !document(element).parents("p,h2,h3,h4,blockquote,ul,ol,pre").length)
    .map((element) => document.html(element));
  return semanticHtmlBlocks(values, {
    minimumCharacters: Math.min(quality.minimumCharacters ?? 300, 300),
    minimumParagraphs: Math.min(quality.minimumParagraphs ?? 3, 3),
  }, pageUrl);
}

export function processNikkei(candidate: Candidate): Candidate {
  return { ...candidate, publisherCategories: [...new Set(candidate.publisherCategories)] };
}
