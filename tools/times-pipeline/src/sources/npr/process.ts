import { load, type CheerioAPI } from "cheerio";
import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";

export type NprDocumentElement = ReturnType<CheerioAPI>[number];

export const NPR_BODY_SELECTOR = "#storytext, .storytext, [data-testid='story-text']";
const BLOCK_SELECTOR = "p, h2, h3, h4, blockquote, ul, ol, pre";
const EXCLUDED_SELECTOR = [
  ".bucketwrap.image",
  ".bucketwrap.internallink",
  ".credit-caption",
  ".caption-wrap",
  "aside",
  "figure",
  "figcaption",
  "[class*='recommend']",
  "[class*='related']",
  "[class*='ad-wrap']",
  "[class*='sponsor']",
].join(",");

function hasBlockAncestor(element: NprDocumentElement, container: NprDocumentElement): boolean {
  let current = element.parent as NprDocumentElement | undefined;
  while (current && current !== container) {
    if ("tagName" in current && /^(?:p|h2|h3|h4|blockquote|ul|ol|pre)$/iu.test(current.tagName)) return true;
    current = current.parent as NprDocumentElement | undefined;
  }
  return false;
}

export interface NprBodyStructure {
  body: ReturnType<CheerioAPI>;
  blockElements: NprDocumentElement[];
}

export function nprBodyStructure(document: CheerioAPI): NprBodyStructure | undefined {
  const body = document(NPR_BODY_SELECTOR).first();
  if (!body.length) return undefined;
  const blockElements = body.find(BLOCK_SELECTOR).toArray().filter((element) => {
    const node = document(element);
    return !node.closest(EXCLUDED_SELECTOR).length && !hasBlockAncestor(element, body[0]!);
  });
  return { body, blockElements };
}

/** NPR's #storytext is the editorial boundary; its enclosing article also has
 * section labels, audio UI, disclosures, tags and recirculation cards. */
export function extractNprBody(html: string, quality: BodyQuality, pageUrl?: string): string | undefined {
  const document = load(html);
  const structure = nprBodyStructure(document);
  if (!structure) return undefined;
  return semanticHtmlBlocks(structure.blockElements.map((element) => document.html(element)), quality, pageUrl);
}
