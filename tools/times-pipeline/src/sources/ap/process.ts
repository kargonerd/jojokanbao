import { load } from "cheerio";
import { semanticParagraphs, type BodyQuality } from "../../content/paragraphs.js";
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

function text(value: string): string {
  const fragment = load(value, undefined, false);
  return fragment.root().text().replaceAll(/\s+/gu, " ").trim();
}

function bodyParagraphs(value: string): string[] {
  const fragment = load(value, undefined, false);
  fragment("br").replaceWith("\n");
  fragment("hr, bsp-hr").replaceWith("\n\n");
  fragment("p, h2, h3, blockquote, li").each((_, element) => {
    fragment(element).prepend("\n").append("\n");
  });
  return fragment.root().text().split(/\n+/u).map((paragraph) => paragraph.trim()).filter(Boolean);
}

export function extractApBody(html: string, quality: BodyQuality): string | undefined {
  const document = load(html);
  const paragraphs: string[] = [];
  document('script[type="application/ld+json"]').each((_, element) => {
    try {
      const blog = liveBlog(JSON.parse(document(element).text()));
      if (!blog || !Array.isArray(blog.liveBlogUpdate)) return;
      for (const value of blog.liveBlogUpdate) {
        const update = object(value);
        if (!update) continue;
        if (typeof update.headline === "string") paragraphs.push(text(update.headline));
        if (typeof update.articleBody === "string") paragraphs.push(...bodyParagraphs(update.articleBody));
      }
    } catch {
      // Continue with another publisher-owned JSON-LD block.
    }
  });
  return semanticParagraphs(paragraphs, quality);
}

export function processAp(candidate: Candidate): Candidate {
  return { ...candidate, publisherCategories: [...new Set(candidate.publisherCategories)] };
}
