import { load } from "cheerio";
import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";

export const FOCUS_TAIWAN_BODY_BLOCKS = "p,h2,h3,h4,blockquote,ul,ol,pre";
export const FOCUS_TAIWAN_EXCLUDED = ".media,.jsAdSlot,[class*='AdBox'],script,style,noscript,iframe";
const END_ITEM = /^Enditem(?:\/\S+)?$/iu;

type Document = ReturnType<typeof load>;
type Selection = ReturnType<Document>;

export function focusTaiwanSemanticBlockHtml(
  document: Document,
  article: Selection,
  stopBefore?: unknown,
): string[] {
  const blocks: string[] = [];
  for (const element of article.find("*").toArray()) {
    if (element === stopBefore) break;
    const node = document(element);
    const text = node.text().replaceAll(/\s+/gu, " ").trim();
    if (node.closest(FOCUS_TAIWAN_EXCLUDED).length
      || !node.is(FOCUS_TAIWAN_BODY_BLOCKS)
      || node.parents(FOCUS_TAIWAN_BODY_BLOCKS).length
      || END_ITEM.test(text)) continue;
    blocks.push(document.html(element));
  }
  return blocks;
}

export function extractFocusTaiwanBody(html: string, quality: BodyQuality, pageUrl?: string): string | undefined {
  const document = load(html);
  const article = document(".paragraph").first();
  if (!article.length) return undefined;
  return semanticHtmlBlocks(focusTaiwanSemanticBlockHtml(document, article), quality, pageUrl);
}
