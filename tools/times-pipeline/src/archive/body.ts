import { load } from "cheerio";
import type { SourcePagePolicy } from "../types.js";

type JsonObject = Record<string, unknown>;

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

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function semanticParagraphs(values: string[]): string | undefined {
  const seen = new Set<string>();
  const paragraphs = values.map((value) => value.replaceAll(/\s+/gu, " ").trim())
    .filter((value) => value.length >= 20 && !seen.has(value) && Boolean(seen.add(value)));
  const text = paragraphs.join("\n");
  const paywallHints = ["subscribe to continue", "sign in to continue", "register to continue", "already a subscriber"];
  if (text.length < 800 || paragraphs.length < 3) return undefined;
  if (text.length < 2_000 && paywallHints.some((hint) => text.toLowerCase().includes(hint))) return undefined;
  return paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("");
}

function richText(value: unknown): string {
  if (Array.isArray(value)) return value.map(richText).join("");
  const row = object(value);
  if (!row) return "";
  if (row.type === "text" && typeof row.value === "string") return row.value;
  return richText(row.content);
}

function bloombergBody(html: string): string | undefined {
  const document = load(html);
  const value = document("script#__NEXT_DATA__").text();
  if (!value) return undefined;
  try {
    const root = object(JSON.parse(value));
    const props = object(root?.props);
    const pageProps = object(props?.pageProps);
    const story = object(pageProps?.story);
    const body = object(story?.body);
    const blocks = Array.isArray(body?.content) ? body.content : [];
    const ignored = new Set(["ad", "embed", "inline-newsletter", "inline-recirc", "media", "tabularData"]);
    return semanticParagraphs(blocks.flatMap((value) => {
      const block = object(value);
      if (!block || (typeof block.type === "string" && ignored.has(block.type))) return [];
      const text = richText(block).trim();
      return text ? [text] : [];
    }));
  } catch {
    return undefined;
  }
}

export function extractRenderedBody(html: string, policy?: SourcePagePolicy): string | undefined {
  if (!html.trim()) return undefined;
  if (policy?.bodyExtractor === "bloomberg-next-data") {
    const extracted = bloombergBody(html);
    if (extracted) return extracted;
  }
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
  if (jsonBody && jsonBody.length >= 800) {
    const result = semanticParagraphs(jsonBody.split(/\r?\n(?:\s*\r?\n)*/u));
    if (result) return result;
  }
  document("script, style, nav, footer, header, aside, form, noscript").remove();
  const selectors = [
    ...(policy?.bodySelectors ?? []),
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
  let best: string | undefined;
  for (const selector of selectors) {
    const values: string[] = [];
    document(selector).each((_, container) => {
      const elements = document(container).find("p, h2, h3, blockquote").toArray();
      if (elements.length) values.push(...elements.map((element) => document(element).text()));
      else values.push(document(container).text());
    });
    const candidate = semanticParagraphs(values);
    if (candidate && (!best || candidate.length > best.length)) best = candidate;
  }
  return best;
}
