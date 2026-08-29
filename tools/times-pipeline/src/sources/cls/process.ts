import { load } from "cheerio";
import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";
import type { Candidate } from "../../types.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

export function extractClsBody(html: string, quality: BodyQuality, pageUrl?: string): string | undefined {
  const document = load(html);
  const value = document("script#__NEXT_DATA__").text();
  if (!value) return undefined;
  try {
    const root = object(JSON.parse(value));
    const pageProps = object(object(root?.props)?.pageProps);
    const article = object(pageProps?.articleDetail);
    if (typeof article?.content !== "string") return undefined;
    const fragment = load(article.content, undefined, false);
    const blocks = fragment("p, h2, h3, blockquote").toArray();
    return semanticHtmlBlocks(
      blocks.length ? blocks.map((element) => fragment.html(element)) : [`<p>${fragment.html()}</p>`],
      quality,
      pageUrl,
    );
  } catch {
    return undefined;
  }
}

export function processCls(candidate: Candidate): Candidate {
  return { ...candidate, publisherCategories: [...new Set(candidate.publisherCategories)] };
}
