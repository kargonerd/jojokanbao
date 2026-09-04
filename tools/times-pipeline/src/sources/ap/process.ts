import { load } from "cheerio";
import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";
import type { Candidate } from "../../types.js";
import type { PublisherArticleTimestamps } from "../contracts.js";

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

export function isApLiveBlogPage(html: string): boolean {
  const document = load(html);
  let found = false;
  document('script[type="application/ld+json"]').each((_, element) => {
    if (found) return;
    try {
      found = Boolean(liveBlog(JSON.parse(document(element).text())));
    } catch {
      // Continue with another publisher-owned JSON-LD block.
    }
  });
  return found;
}

function newsArticle(value: unknown): JsonObject | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = newsArticle(item);
      if (result) return result;
    }
    return undefined;
  }
  const row = object(value);
  if (!row) return undefined;
  const types = Array.isArray(row["@type"]) ? row["@type"] : [row["@type"]];
  if (types.includes("NewsArticle")) return row;
  for (const item of Object.values(row)) {
    const result = newsArticle(item);
    if (result) return result;
  }
  return undefined;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString();
}

export function extractApTimestamps(html: string): PublisherArticleTimestamps | undefined {
  const document = load(html);
  let result: PublisherArticleTimestamps | undefined;
  document('script[type="application/ld+json"]').each((_, element) => {
    if (result) return;
    try {
      const article = newsArticle(JSON.parse(document(element).text()));
      const publishedAt = timestamp(article?.datePublished);
      if (!publishedAt) return;
      const modifiedAt = timestamp(article?.dateModified);
      result = {
        publishedAt,
        ...(modifiedAt && modifiedAt > publishedAt ? { updatedAt: modifiedAt } : {}),
      };
    } catch {
      // Continue with another publisher-owned JSON-LD block.
    }
  });
  return result;
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

const AP_SEPARATOR = /^_{3,}$/u;
const AP_TRAILING_NOTE = /^(?:For more on .+?:|(?:The Associated Press(?:['’]s?)?(?: [^.]{0,180}\bcoverage)?|Global health and development coverage) receives (?:financial )?support\b|Find AP(?:'|’)?s standards for working with philanthropies\b)/iu;

function storyBody(document: ReturnType<typeof load>, quality: BodyQuality, pageUrl?: string): string | undefined {
  const container = document(".RichTextStoryBody, [itemprop='articleBody']").first();
  if (!container.length) return undefined;
  const values: string[] = [];
  const contentValues: string[] = [];
  let separatorIndex = 0;
  for (const element of container.children().toArray()) {
    const node = document(element);
    if (!node.is("p,h2,h3,h4,blockquote,ul,ol,pre")) continue;
    const text = node.text().replaceAll(/\s+/gu, " ").trim();
    if (AP_TRAILING_NOTE.test(text)) {
      while (values.at(-1)?.startsWith("<p>JOJO_AP_SEPARATOR_")) values.pop();
      break;
    }
    if (node.is("p") && AP_SEPARATOR.test(text)) {
      values.push(`<p>JOJO_AP_SEPARATOR_${separatorIndex}_DO_NOT_DISPLAY</p>`);
      separatorIndex += 1;
      continue;
    }
    const html = document.html(element);
    values.push(html);
    contentValues.push(html);
  }
  if (!semanticHtmlBlocks(contentValues, quality, pageUrl)) return undefined;
  return semanticHtmlBlocks(values, { minimumCharacters: 0, minimumParagraphs: 0 }, pageUrl)
    ?.replaceAll(/<p>JOJO_AP_SEPARATOR_\d+_DO_NOT_DISPLAY<\/p>/gu, "<hr>");
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
  return semanticHtmlBlocks(paragraphs, quality, pageUrl) ?? storyBody(document, quality, pageUrl);
}

export function processAp(candidate: Candidate): Candidate {
  return { ...candidate, publisherCategories: [...new Set(candidate.publisherCategories)] };
}
