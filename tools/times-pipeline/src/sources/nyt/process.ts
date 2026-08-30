import { load, type CheerioAPI } from "cheerio";
import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";

type DocumentElement = ReturnType<CheerioAPI>[number];

interface AuthorLink {
  href: string;
  name: string;
}

const BODY_BLOCK_SELECTOR = "p, h2, h3, h4, blockquote, ul, ol, pre";
const SUMMARY_SELECTORS = [
  "#article-summary",
  "[data-testid='article-summary']",
  "[name='article-summary']",
  "#article-description",
  "[data-testid='article-description']",
  "[name='article-description']",
] as const;
const RECIRCULATION_HINT = /(?:recirculation|related[-_\s]?content|recommended[-_\s]?content)/iu;
const RELATED_CONTENT_HEADING = /^(?:Related Content|More (?:to Read|From)|Recommended)(?:\s|$)/iu;

function normalizedText(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function absoluteAuthorUrl(value: string | undefined, pageUrl?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, pageUrl ?? "https://www.nytimes.com/");
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function pageAuthors(document: CheerioAPI, pageUrl?: string): AuthorLink[] {
  const authors: AuthorLink[] = [];
  const seen = new Set<string>();
  document("a[href*='/by/']").each((_, element) => {
    const node = document(element);
    const name = normalizedText(node.text()).replace(/^By\s+/iu, "");
    const href = absoluteAuthorUrl(node.attr("href"), pageUrl);
    const key = `${name}\n${href ?? ""}`;
    if (!name || !href || seen.has(key)) return;
    seen.add(key);
    authors.push({ href, name });
  });
  return authors.toSorted((left, right) => right.name.length - left.name.length);
}

function restorePlainTextAuthorLink(
  document: CheerioAPI,
  element: DocumentElement,
  authors: readonly AuthorLink[],
): string {
  const node = document(element).clone();
  if (!node.is("p") || node.find("a").length) return document.html(element);
  const paragraphText = normalizedText(node.text());
  for (const author of authors) {
    if (!paragraphText.includes(`${author.name} is `)) continue;
    const html = node.html() ?? "";
    const escapedName = escapeHtml(author.name);
    const nameIndex = html.indexOf(escapedName);
    if (nameIndex < 0) continue;
    node.html(`${html.slice(0, nameIndex)}<a href="${author.href}">${escapedName}</a>${html.slice(nameIndex + escapedName.length)}`);
    break;
  }
  return document.html(node[0]!);
}

function isPublisherRecirculation(document: CheerioAPI, element: DocumentElement, section: DocumentElement): boolean {
  let current: DocumentElement | undefined = element;
  while (current && current !== section) {
    if ("tagName" in current) {
      const tag = current.tagName.toLowerCase();
      if (["aside", "figcaption", "figure"].includes(tag)) return true;
      const node = document(current);
      const identity = [
        node.attr("id"),
        node.attr("class"),
        node.attr("data-testid"),
        node.attr("data-component"),
        node.attr("data-module"),
        node.attr("aria-label"),
      ].filter(Boolean).join(" ");
      if (RECIRCULATION_HINT.test(identity)) return true;
    }
    current = current.parent as DocumentElement | undefined;
  }
  return false;
}

export function nytVisibleSummary(document: CheerioAPI, pageUrl?: string): string | undefined {
  const blocks = nytVisibleSummaryBlocks(document, pageUrl);
  return blocks.length ? blocks.map((block) => block.html).join("") : undefined;
}

function rawNytVisibleSummaryBlocks(document: CheerioAPI): Array<{ html: string; text: string }> {
  for (const selector of SUMMARY_SELECTORS) {
    const node = document(selector).first();
    const text = normalizedText(node.text());
    if (!node.length || !text) continue;
    if (node.is(BODY_BLOCK_SELECTOR)) return [{ html: document.html(node[0]!), text }];
    const elements = node.find(BODY_BLOCK_SELECTOR).toArray()
      .filter((element) => !document(element).parents(BODY_BLOCK_SELECTOR).length);
    if (elements.length) return elements.map((element) => ({
      html: document.html(element),
      text: normalizedText(document(element).text()),
    })).filter((block) => block.text);
    return [{ html: document.html(node[0]!), text }];
  }
  const description = normalizedText(document("meta[name='description']").first().attr("content") ?? "");
  return description ? [{ html: `<p>${escapeHtml(description)}</p>`, text: description }] : [];
}

function nytVisibleSummaryBlocks(document: CheerioAPI, pageUrl?: string): Array<{ html: string; text: string }> {
  return rawNytVisibleSummaryBlocks(document).flatMap((block) => {
    const html = semanticHtmlBlocks(
      [block.html],
      { minimumCharacters: 0, minimumParagraphs: 0 },
      pageUrl,
    );
    if (!html) return [];
    const fragment = load(html, undefined, false);
    const text = normalizedText(fragment.root().text());
    return text ? [{ html, text }] : [];
  });
}

export function nytVisibleSummaryBlockCount(document: CheerioAPI, pageUrl?: string): number {
  return nytVisibleSummaryBlockTexts(document, pageUrl).length;
}

/**
 * Text keys used by semanticHtmlBlocks for the visible standfirst. Image
 * placement seeds its de-duplication set with the same keys so a standfirst
 * repeated as the first articleBody paragraph consumes only one body slot.
 */
export function nytVisibleSummaryBlockTexts(document: CheerioAPI, pageUrl?: string): string[] {
  return [...new Set(nytVisibleSummaryBlocks(document, pageUrl).map((block) => block.text))];
}

/**
 * Extracts the NYT story instead of treating the first articleBody section as a
 * complete article. NYT keeps the standfirst, story sections, captions and
 * recirculation modules in separate DOM branches.
 */
export function extractNytBody(html: string, quality: BodyQuality, pageUrl?: string): string | undefined {
  const document = load(html);
  const sections = document("section[name='articleBody']").toArray();
  if (!sections.length) return undefined;

  const authors = pageAuthors(document, pageUrl);
  const blocks: string[] = [];
  blocks.push(...nytVisibleSummaryBlocks(document, pageUrl).map((block) => block.html));

  let reachedRelatedContent = false;
  for (const section of sections) {
    for (const element of document(section).find(BODY_BLOCK_SELECTOR).toArray()) {
      if (isPublisherRecirculation(document, element, section)) continue;
      const node = document(element);
      if (node.parents(BODY_BLOCK_SELECTOR).filter((_, parent) => parent !== section).length) continue;
      const text = normalizedText(node.text());
      if (node.is("h2,h3,h4") && RELATED_CONTENT_HEADING.test(text)) {
        reachedRelatedContent = true;
        break;
      }
      blocks.push(restorePlainTextAuthorLink(document, element, authors));
    }
    if (reachedRelatedContent) break;
  }

  return semanticHtmlBlocks(blocks, quality, pageUrl);
}
