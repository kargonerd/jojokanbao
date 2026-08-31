import { load, type CheerioAPI } from "cheerio";
import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";

export type GuardianDocumentElement = ReturnType<CheerioAPI>[number];

export const GUARDIAN_BODY_SELECTOR = "[data-gu-name='body'], .article-body-commercial-selector";
const BLOCK_SELECTOR = "p, h2, h3, h4, blockquote, ul, ol, pre";
const EXCLUDED_SELECTOR = [
  "aside",
  "figure",
  "figcaption",
  "[data-gu-name='tags']",
  "[data-gu-name*='related']",
  "[data-gu-name*='recommend']",
  "[data-print-layout='hide']",
  "[class*='ad-slot']",
  "[class*='related']",
  "[class*='recommend']",
].join(",");
const WORD_INTERNAL_SPELLING_MARK = /(?<=\p{L})<s\b[^>]*>\s*(\p{L})\s*<\/s>(?=\p{L})/giu;

function hasBlockAncestor(element: GuardianDocumentElement, container: GuardianDocumentElement): boolean {
  let current = element.parent as GuardianDocumentElement | undefined;
  while (current && current !== container) {
    if ("tagName" in current && /^(?:p|h2|h3|h4|blockquote|ul|ol|pre)$/iu.test(current.tagName)) return true;
    current = current.parent as GuardianDocumentElement | undefined;
  }
  return false;
}

function ownedBlockElements(document: CheerioAPI, container: GuardianDocumentElement): GuardianDocumentElement[] {
  return document(container).find(BLOCK_SELECTOR).toArray().flatMap((element) => {
    const node = document(element);
    if (node.closest(EXCLUDED_SELECTOR).length || hasBlockAncestor(element, container)) return [];
    return [element];
  });
}

export interface GuardianBodyStructure {
  body: ReturnType<CheerioAPI>;
  blockElements: GuardianDocumentElement[];
}

export function guardianBodyStructure(document: CheerioAPI): GuardianBodyStructure | undefined {
  const body = document(GUARDIAN_BODY_SELECTOR).first();
  if (!body.length) return undefined;
  const standfirst = document("[data-gu-name='standfirst']").first();
  return {
    body,
    blockElements: [
      ...(standfirst.length ? ownedBlockElements(document, standfirst[0]!) : []),
      ...ownedBlockElements(document, body[0]!),
    ],
  };
}

/**
 * Guardian keeps its standfirst outside data-gu-name="body" and its topic
 * taxonomy elsewhere in the enclosing article. Reading the whole article
 * therefore either loses the standfirst or appends navigation as prose.
 */
export function extractGuardianBody(html: string, quality: BodyQuality, pageUrl?: string): string | undefined {
  const document = load(html);
  const structure = guardianBodyStructure(document);
  if (!structure) return undefined;
  // Guardian liveblogs sometimes wrap the British-only letter in a spelling
  // variant with <s>, for example favo<s>u</s>rite. It is editorial diff
  // markup, not semantic strikethrough. Keep the exception publisher-local
  // and exact so ordinary deleted words and sentences remain protected.
  const blocks = structure.blockElements.map((element) => document.html(element)
    .replace(WORD_INTERNAL_SPELLING_MARK, "$1"));
  return semanticHtmlBlocks(blocks, quality, pageUrl);
}
