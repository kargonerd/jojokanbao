import { load, type CheerioAPI } from "cheerio";
import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";

type DocumentElement = ReturnType<CheerioAPI>[number];

const BLOCK_SELECTOR = "p, h2, h3, h4, blockquote, ul, ol, pre, hr";
const BODY_SELECTOR = ".gtm-story-text, [data-testid='story-body']";
const EXCLUDED_SELECTOR = [
  "figure", "figcaption", "aside", "[class*='author']", "[class*='byline']", "[class*='share']",
  "[class*='preferred']", "[class*='promo']", "[class*='recommend']", "[class*='related']", "[class*='advert']",
  "[data-testid*='author']", "[data-testid*='share']", "[data-testid*='recommend']",
].join(",");
const PUBLISHER_PROMO = /^(?:Add Axios as your preferred source|see more of our stories on Google\.?$)/iu;

function normalizedText(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function hasBlockAncestor(element: DocumentElement, container: DocumentElement): boolean {
  let current = element.parent as DocumentElement | undefined;
  while (current && current !== container) {
    if ("tagName" in current && /^(?:p|h2|h3|h4|blockquote|ul|ol|pre)$/iu.test(current.tagName)) return true;
    current = current.parent as DocumentElement | undefined;
  }
  return false;
}

function sourceBlocks(document: CheerioAPI, container: DocumentElement): { content: string[]; values: string[] } {
  const content: string[] = [];
  const values: string[] = [];
  let separator = 0;
  for (const element of document(container).find(BLOCK_SELECTOR).toArray()) {
    const node = document(element);
    if (node.closest(EXCLUDED_SELECTOR).length || hasBlockAncestor(element, container)) continue;
    if (node.is("hr")) {
      values.push(`<p>JOJO_AXIOS_SEPARATOR_${separator}_DO_NOT_DISPLAY</p>`);
      separator += 1;
      continue;
    }
    const text = normalizedText(node.text());
    if (!text || PUBLISHER_PROMO.test(text) || (/^(?:Illustration|Photo):/iu.test(text) && text.length < 160)) continue;
    const html = document.html(element);
    content.push(html);
    values.push(html);
  }
  return { content, values };
}

function fragmentContainer(document: CheerioAPI): ReturnType<CheerioAPI> {
  const root = document.root();
  const hasArticleShell = document("article,main,header,nav").length > 0;
  return hasArticleShell ? document("") : root;
}

export function extractAxiosBody(html: string, quality: BodyQuality, pageUrl?: string): string | undefined {
  const document = load(html, undefined, false);
  const container = document(BODY_SELECTOR).first().length ? document(BODY_SELECTOR).first() : fragmentContainer(document);
  if (!container.length) return undefined;
  const { content, values } = sourceBlocks(document, container[0]!);
  if (!semanticHtmlBlocks(content, quality, pageUrl)) return undefined;
  return semanticHtmlBlocks(values, { minimumCharacters: 0, minimumParagraphs: 0 }, pageUrl)
    ?.replaceAll(/<p>JOJO_AXIOS_SEPARATOR_\d+_DO_NOT_DISPLAY<\/p>/gu, "<hr>");
}
