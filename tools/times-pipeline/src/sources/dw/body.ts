import { load, type CheerioAPI } from "cheerio";
import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";

export type DwDocumentElement = ReturnType<CheerioAPI>[number];

const PROMOTIONAL_TEXT = /^(?:Tired of missing our real-time updates\?|Click here to add (?:us|DW) as a Preferred Source|If you rely on our team for trusted reporting|Don't let the algorithm hide the news\.|Edited by:)/iu;

function normalizedText(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function isStoryNode(
  node: ReturnType<CheerioAPI>,
  text: string,
): boolean {
  if (!node.is("p,h2,h3,h4,blockquote,ul,ol,pre")) return false;
  if (!text || PROMOTIONAL_TEXT.test(text)) return false;
  if (node.closest("figure,figcaption,footer,aside,.feedback,.embed,.vjs-wrapper,[class*='advert']").length) return false;
  if (node.closest(".rich-text").length) return true;
  return node.is("h2") && node.closest(".liveblog-post,.content-block").length > 0;
}

function hasStoryBlockAncestor(element: DwDocumentElement, article: DwDocumentElement): boolean {
  let current = element.parent as DwDocumentElement | undefined;
  while (current && current !== article) {
    if ("tagName" in current && /^(?:p|h2|h3|h4|blockquote|ul|ol|pre)$/iu.test(current.tagName)) return true;
    current = current.parent as DwDocumentElement | undefined;
  }
  return false;
}

export function dwStoryBlockElements(document: CheerioAPI, article: ReturnType<CheerioAPI>): DwDocumentElement[] {
  if (!article.length || !article.find(".rich-text").length) return [];
  return article.find("p,h2,h3,h4,blockquote,ul,ol,pre").toArray().filter((element) => {
    const node = document(element);
    return isStoryNode(node, normalizedText(node.text())) && !hasStoryBlockAncestor(element, article[0]!);
  });
}

export function extractDwBody(html: string, quality: BodyQuality, pageUrl?: string): string | undefined {
  const document = load(html);
  const article = document("article").first();
  const values = dwStoryBlockElements(document, article).map((element) => document.html(element));
  if (!values.length) return undefined;
  return semanticHtmlBlocks(values, quality, pageUrl);
}
