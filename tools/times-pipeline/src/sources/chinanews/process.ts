import { load } from "cheerio";
import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";

const ARTICLE_SELECTORS = [".left_zw", ".content_desc"] as const;

export function extractChinanewsBody(html: string, quality: BodyQuality, pageUrl?: string): string | undefined {
  const document = load(html);
  const article = ARTICLE_SELECTORS
    .map((selector) => document(selector).first())
    .find((candidate) => candidate.length > 0);
  if (!article) return undefined;

  const body = article.clone();
  body.find([
    "script",
    "style",
    "noscript",
    "iframe",
    "form",
    ".adInContent",
    ".adEditor",
    "#function_code_page",
  ].join(",")).remove();

  const blocks = body.find("p, h2, h3, blockquote").toArray();
  const paragraphs = blocks.length
    ? blocks.map((element) => document.html(element))
    : [`<p>${body.html() ?? body.text()}</p>`];
  return semanticHtmlBlocks(paragraphs, quality, pageUrl);
}
