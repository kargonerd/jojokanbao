import { load } from "cheerio";
import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";

const BODY_SELECTOR = "article.node--article-content section.block-field-blocknodearticlefield-content .text-long";
const BLOCK_SELECTOR = "p,h2,h3,h4,blockquote,ul,ol,pre";
const EXCLUDED = [
  ".in-article-games",
  ".also-worth-reading",
  "[class*='newsletter']",
  "[class*='notification']",
  "[class*='whatsapp']",
  "[class*='advert']",
  "script",
  "style",
  "noscript",
  "iframe",
].join(",");

export function extractCnaBody(html: string, quality: BodyQuality, pageUrl?: string): string | undefined {
  const document = load(html);
  const blocks: string[] = [];
  document(BODY_SELECTOR).each((_, container) => {
    const article = document(container).clone();
    article.find(EXCLUDED).remove();
    blocks.push(...article.find(BLOCK_SELECTOR).toArray()
      .filter((element) => !document(element).parents(BLOCK_SELECTOR).length)
      .map((element) => document.html(element)));
  });
  return semanticHtmlBlocks(blocks, quality, pageUrl);
}
