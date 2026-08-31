import { load } from "cheerio";
import type { ArticleBodyExtraction } from "../../content/body.js";
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

export function extractFocusTaiwanBody(
  html: string,
  quality: BodyQuality,
  pageUrl?: string,
): string | ArticleBodyExtraction | undefined {
  const document = load(html);
  const article = document(".paragraph").first();
  if (!article.length) return undefined;
  const blocks = focusTaiwanSemanticBlockHtml(document, article);
  const regularBody = semanticHtmlBlocks(blocks, quality, pageUrl);
  if (regularBody) return regularBody;

  // Focus Taiwan closes complete wire stories with an Enditem marker inside
  // the publisher-owned author block. That boundary lets us distinguish a
  // legitimate one-paragraph market brief from an RSS summary or a truncated
  // generic article container without lowering the source-wide quality gate.
  const hasEndItem = article.find(".author p").toArray().some((element) => (
    END_ITEM.test(document(element).text().replaceAll(/\s+/gu, " ").trim())
  ));
  if (!hasEndItem) return undefined;
  return {
    html: blocks.join(""),
    completeness: "publisher-complete",
    evidence: {
      kind: "terminal-marker",
      marker: "Enditem",
      location: ".paragraph .author p",
    },
  };
}
