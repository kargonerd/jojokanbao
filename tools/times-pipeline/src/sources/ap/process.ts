import { load } from "cheerio";
import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";
import type { Candidate } from "../../types.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function liveBlog(value: unknown): JsonObject | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = liveBlog(item);
      if (result) return result;
    }
    return undefined;
  }
  const row = object(value);
  if (!row) return undefined;
  const types = Array.isArray(row["@type"]) ? row["@type"] : [row["@type"]];
  if (types.includes("LiveBlogPosting")) return row;
  for (const item of Object.values(row)) {
    const result = liveBlog(item);
    if (result) return result;
  }
  return undefined;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function bodyParagraphs(value: string): string[] {
  const fragment = load(value, undefined, false);
  fragment("hr, bsp-hr").remove();
  const blocks = fragment("p, h2, h3, blockquote, li").toArray();
  if (blocks.length) return blocks.map((element) => fragment(element).is("li")
    ? `<p>${fragment(element).html() ?? fragment(element).text()}</p>`
    : fragment.html(element));
  return fragment.html().split(/(?:<br\s*\/?>\s*)+/iu)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${paragraph}</p>`);
}

export function extractApBody(html: string, quality: BodyQuality, pageUrl?: string): string | undefined {
  const document = load(html);
  const paragraphs: string[] = [];
  document('script[type="application/ld+json"]').each((_, element) => {
    try {
      const blog = liveBlog(JSON.parse(document(element).text()));
      if (!blog || !Array.isArray(blog.liveBlogUpdate)) return;
      for (const value of blog.liveBlogUpdate) {
        const update = object(value);
        if (!update) continue;
        if (typeof update.headline === "string") paragraphs.push(`<h2>${escapeHtml(update.headline)}</h2>`);
        if (typeof update.articleBody === "string") paragraphs.push(...bodyParagraphs(update.articleBody));
      }
    } catch {
      // Continue with another publisher-owned JSON-LD block.
    }
  });
  return semanticHtmlBlocks(paragraphs, quality, pageUrl);
}

export function processAp(candidate: Candidate): Candidate {
  return { ...candidate, publisherCategories: [...new Set(candidate.publisherCategories)] };
}
