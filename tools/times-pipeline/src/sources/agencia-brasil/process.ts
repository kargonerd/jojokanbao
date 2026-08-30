import { load } from "cheerio";
import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";

const BLOCK_SELECTOR = "p,h2,h3,h4,blockquote,ul,ol,pre";
const EXCLUDED_SELECTOR = [
  "figure",
  "figcaption",
  "aside",
  "[class*='advert']",
  "[class*='related']",
  "[class*='recommend']",
  "[class*='share']",
].join(",");

export function extractAgenciaBrasilBody(html: string, quality: BodyQuality, pageUrl?: string): string | undefined {
  const document = load(html);
  const body = document(".field--name-body").first();
  if (!body.length) return undefined;
  const blocks = body.find(BLOCK_SELECTOR).toArray().flatMap((element) => {
    const node = document(element);
    if (node.closest(EXCLUDED_SELECTOR).length || node.parents(BLOCK_SELECTOR).length) return [];
    return [document.html(element)];
  });
  return semanticHtmlBlocks(blocks, quality, pageUrl);
}
