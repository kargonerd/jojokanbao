import { load } from "cheerio";
import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";

export const AL_JAZEERA_SEMANTIC_BLOCKS = "p, h2, h3, h4, blockquote, li, pre";
const BRIEF_QUALITY = { minimumCharacters: 350, minimumParagraphs: 3 };
const AUTHORITATIVE_STORY_CONTAINERS = [
  "main .wysiwyg",
  "article .wysiwyg",
  "main.wysiwyg",
  "article.wysiwyg",
].join(",");
const REJECTED_STORY_ANCESTORS = [
  "aside",
  "footer",
  "nav",
  "[role='navigation']",
  "[class*='error-page']",
  "[class*='access-gate']",
  "[class*='paywall']",
  "[data-component*='error']",
  "[data-component*='access']",
  "[data-component*='paywall']",
].join(",");
const PUBLISHER_STORY_MARKERS = [
  "article",
  ".wysiwyg--all-content",
  "[data-component*='article-body']",
  "[data-component*='live-blog']",
  "[class*='live-blog']",
  ".article-p-wrapper",
  ".compact-featured-area__content",
].join(",");
export const AL_JAZEERA_EXCLUDED_CONTENT = [
  ".more-on",
  ".container--ads",
  ".in-article-ads",
  "[class*='advert']",
  "[data-component*='recommend']",
  "figure",
  "script",
  "style",
  "noscript",
  "iframe",
].join(",");

type Document = ReturnType<typeof load>;
type Selection = ReturnType<Document>;

export function alJazeeraStoryContainers(document: Document): Selection[] {
  return document(AUTHORITATIVE_STORY_CONTAINERS).toArray()
    .map((element) => document(element))
    .filter((container) => !container.closest(REJECTED_STORY_ANCESTORS).length)
    .filter((container) => !container.parents(".wysiwyg").length);
}

function explicitPublisherStory(container: Selection): boolean {
  return container.is(PUBLISHER_STORY_MARKERS) || container.closest(PUBLISHER_STORY_MARKERS).length > 0;
}

/**
 * Return the exact source blocks that the body extractor will hand to the
 * semantic sanitizer. Lists intentionally expand to one paragraph per item,
 * matching the live-blog representation used in the archived body.
 */
export function alJazeeraSemanticBlockHtml(
  document: Document,
  container: Selection,
  stopBefore?: unknown,
): string[] {
  const blocks: string[] = [];
  for (const element of container.find("*").toArray()) {
    if (element === stopBefore) break;
    const node = document(element);
    if (node.closest(AL_JAZEERA_EXCLUDED_CONTENT).length
      || !node.is(AL_JAZEERA_SEMANTIC_BLOCKS)
      || node.find(AL_JAZEERA_SEMANTIC_BLOCKS).length) continue;
    blocks.push(node.is("li")
      ? `<p>${node.html() ?? node.text()}</p>`
      : document.html(element));
  }
  return blocks;
}

export function extractAlJazeeraBody(html: string, quality: BodyQuality, pageUrl?: string): string | undefined {
  const document = load(html);
  const containers = alJazeeraStoryContainers(document);
  const paragraphs = containers.flatMap((container) => alJazeeraSemanticBlockHtml(document, container));
  const semantic = semanticHtmlBlocks(paragraphs, quality, pageUrl);
  if (semantic) return semantic;

  const publisherBrief = containers.filter(explicitPublisherStory)
    .flatMap((container) => alJazeeraSemanticBlockHtml(document, container));
  return semanticHtmlBlocks(publisherBrief, BRIEF_QUALITY, pageUrl);
}
