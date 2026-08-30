import { load } from "cheerio";
import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";

const BLOCK_SELECTOR = "p,h2,h3,h4,blockquote,ul,ol,pre";
const TRAILING_HEADING = /^(?:Related articles|More (?:from|on)\b.*)$/iu;

export function extractAfricanewsBody(html: string, quality: BodyQuality, pageUrl?: string): string | undefined {
  const document = load(html);
  const container = document(".article-content__text").first().length
    ? document(".article-content__text").first()
    : document(".article-content").first();
  if (!container.length) return undefined;

  const values: string[] = [];
  for (const element of container.find(BLOCK_SELECTOR).toArray()) {
    const node = document(element);
    if (node.closest("figure,figcaption,aside,.advertising,[class*='related']").length
      || node.parents(BLOCK_SELECTOR).length) continue;
    const text = node.text().replaceAll(/\s+/gu, " ").trim();
    if (node.is("h2,h3,h4") && TRAILING_HEADING.test(text)) break;
    values.push(document.html(element));
  }
  return semanticHtmlBlocks(values, quality, pageUrl);
}
