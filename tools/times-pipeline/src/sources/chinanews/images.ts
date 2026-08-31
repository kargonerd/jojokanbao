import { load } from "cheerio";
import type { PageImageCandidate } from "../../capture/page-images.js";
import {
  inspectChinanewsImageOnlyPoster,
  isChinanewsResidualPage,
  isChinanewsSemanticBlock,
} from "./process.js";

const EXCLUDED_SELECTOR = ".adInContent,.adEditor,#function_code_page,script,style,noscript,iframe,form";
const CAPTION_SELECTOR = ".pictext,[class*='caption'],figcaption";

function text(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function absoluteUrl(value: string | undefined, pageUrl: string): string | undefined {
  if (!value || value.startsWith("data:") || value.startsWith("blob:")) return undefined;
  try {
    const url = new URL(value, pageUrl);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function dimension(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function associatedCaption(
  document: ReturnType<typeof load>,
  image: ReturnType<ReturnType<typeof load>>,
  article: ReturnType<ReturnType<typeof load>>,
): string | undefined {
  const ownCaption = image.closest("figure,p,div").first().find(CAPTION_SELECTOR).first();
  if (ownCaption.length) return text(ownCaption.text()) || undefined;

  let owner = image.closest("figure,p,div").first();
  while (owner.length && owner.get(0) !== article.get(0)) {
    const caption = owner.next(CAPTION_SELECTOR).first();
    if (caption.length) return text(caption.text()) || undefined;
    owner = owner.parent();
  }
  return undefined;
}

export function extractChinanewsImages(html: string, pageUrl: string): PageImageCandidate[] {
  const poster = inspectChinanewsImageOnlyPoster(html, pageUrl);
  if (poster.imageOnlyShell) {
    return poster.sourceUrl
      ? [{ sourceUrl: poster.sourceUrl, role: "content", afterBlock: 0 }]
      : [];
  }

  const document = load(html);
  const article = [".left_zw", ".content_desc"]
    .map((selector) => document(selector).first())
    .find((candidate) => candidate.length > 0);
  if (!article) return [];

  const semanticContainer = article.clone();
  semanticContainer.find(`${EXCLUDED_SELECTOR},${CAPTION_SELECTOR}`).remove();
  const semanticBlocks = semanticContainer.find("p,h2,h3,h4,blockquote").length;
  if (isChinanewsResidualPage(semanticContainer.text(), semanticBlocks)) return [];

  const images: PageImageCandidate[] = [];
  const seen = new Set<string>();
  const seenBlocks = new Set<string>();
  let blockCount = 0;
  article.find("p,h2,h3,h4,blockquote,img").each((_index, element) => {
    const node = document(element);
    if (node.closest(EXCLUDED_SELECTOR).length) return;
    if (node.is("img")) {
      const sourceUrl = absoluteUrl(node.attr("data-src") ?? node.attr("data-original") ?? node.attr("src"), pageUrl);
      if (!sourceUrl || seen.has(sourceUrl)) return;
      seen.add(sourceUrl);
      const caption = associatedCaption(document, node, article);
      const alt = text(node.attr("alt") ?? "") || caption;
      const width = dimension(node.attr("width"));
      const height = dimension(node.attr("height"));
      images.push({
        sourceUrl,
        role: "content",
        afterBlock: blockCount,
        ...(alt ? { alt } : {}),
        ...(caption ? { caption } : {}),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
      });
      return;
    }
    if (node.closest(CAPTION_SELECTOR).length) return;
    const semanticNode = node.clone();
    semanticNode.find(`img,${CAPTION_SELECTOR}`).remove();
    const value = text(semanticNode.text());
    const tagName = node.prop("tagName")?.toLowerCase() ?? "";
    if (isChinanewsSemanticBlock(tagName, value) && !seenBlocks.has(value)) {
      seenBlocks.add(value);
      blockCount += 1;
    }
  });
  return images;
}
