import { load } from "cheerio";
import type { PageImageCandidate } from "../../capture/page-images.js";
import { semanticHtmlBlocks } from "../../content/paragraphs.js";
import { dwStoryBlockElements, type DwDocumentElement } from "./body.js";

interface ImageUrlCandidate {
  url: string;
  score: number;
}

function normalizedText(value: string): string {
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

function srcsetCandidates(value: string | undefined, pageUrl: string): ImageUrlCandidate[] {
  return value?.split(",").flatMap((entry, index) => {
    const [rawUrl, descriptor] = entry.trim().split(/\s+/u);
    const url = absoluteUrl(rawUrl, pageUrl);
    if (!url) return [];
    const parsed = descriptor?.match(/^(\d+(?:\.\d+)?)(w|x)$/u);
    const score = parsed ? Number(parsed[1]) * (parsed[2] === "x" ? 10_000 : 1) : index;
    return [{ url, score }];
  }) ?? [];
}

function imageUrl(
  document: ReturnType<typeof load>,
  image: ReturnType<ReturnType<typeof load>>,
  pageUrl: string,
): string | undefined {
  const picture = image.closest("picture");
  const candidates = [
    ...srcsetCandidates(image.attr("data-srcset") ?? image.attr("srcset"), pageUrl),
    ...picture.find("source[type='image/jpeg'],source:not([type])").toArray()
      .flatMap((source) => srcsetCandidates(document(source).attr("data-srcset") ?? document(source).attr("srcset"), pageUrl)),
  ].toSorted((left, right) => right.score - left.score);
  if (candidates[0]) return candidates[0].url;

  const template = image.attr("data-url");
  if (template) {
    const expanded = template.replace("${formatId}", "605");
    const url = absoluteUrl(expanded, pageUrl);
    if (url) return url;
  }
  return absoluteUrl(image.attr("data-src") ?? image.attr("data-original") ?? image.attr("src"), pageUrl);
}

function emittedBlockCount(
  document: ReturnType<typeof load>,
  elements: DwDocumentElement[],
  pageUrl: string,
): number {
  const body = semanticHtmlBlocks(elements.map((element) => document.html(element)), {
    minimumCharacters: 0,
    minimumParagraphs: 0,
  }, pageUrl);
  return body ? load(body, undefined, false).root().children("blockquote,h2,h3,h4,ol,p,pre,ul").length : 0;
}

export function extractDwImages(html: string, pageUrl: string): PageImageCandidate[] {
  const document = load(html);
  const article = document("article").first();
  if (!article.length) return [];
  const storyBlocks = dwStoryBlockElements(document, article);
  const order = new Map<DwDocumentElement, number>();
  article.find("*").each((index, element) => {
    order.set(element, index);
  });
  const images: PageImageCandidate[] = [];
  const seenUrls = new Set<string>();
  let leadAssigned = false;

  article.find("figure").each((_, element) => {
    const node = document(element);
    if (node.closest("footer,aside,.feedback,.embed,.vjs-wrapper,[class*='advert'],[class*='related']").length) return;
    const image = node.find("img").first();
    const sourceUrl = imageUrl(document, image, pageUrl);
    if (!sourceUrl || seenUrls.has(sourceUrl)) return;
    const alt = normalizedText(image.attr("alt") ?? "") || undefined;
    if (/(?:logo|icon|avatar|tracking|pixel|sprite|placeholder)/iu.test(`${sourceUrl} ${alt ?? ""}`)) return;

    const captionNode = node.find("figcaption").first().clone();
    const creditNode = captionNode.find("small.copyright,.copyright").first();
    const credit = normalizedText(creditNode.text()).replace(/^Image:\s*/iu, "") || undefined;
    creditNode.remove();
    const description = normalizedText(captionNode.text()) || undefined;
    const caption = [description, credit].filter(Boolean).join(" ") || undefined;
    const lead = !leadAssigned && !node.closest(".rich-text,.liveblog-post").length;
    const figureOrder = order.get(element);
    const afterBlock = lead ? undefined : emittedBlockCount(document, storyBlocks.filter((block) => {
      const blockOrder = order.get(block);
      return blockOrder !== undefined && figureOrder !== undefined && blockOrder < figureOrder;
    }), pageUrl);
    if (lead) leadAssigned = true;
    seenUrls.add(sourceUrl);
    images.push({
      sourceUrl,
      role: lead ? "lead" : "content",
      ...(!lead ? { afterBlock: afterBlock ?? 0 } : {}),
      ...(alt ? { alt } : {}),
      ...(caption ? { caption } : {}),
      ...(credit ? { credit } : {}),
    });
  });

  if (!leadAssigned) {
    const leadUrl = absoluteUrl(
      document("meta[property='og:image']").attr("content")
        ?? document("meta[name='twitter:image']").attr("content"),
      pageUrl,
    );
    if (leadUrl && !seenUrls.has(leadUrl)) {
      images.unshift({ sourceUrl: leadUrl, role: "lead" });
    } else if (leadUrl) {
      const existing = images.findIndex((image) => image.sourceUrl === leadUrl);
      if (existing >= 0) {
        const { afterBlock: _afterBlock, ...fallbackLead } = images[existing]!;
        images[existing] = { ...fallbackLead, role: "lead" };
      }
    }
  }
  return images;
}
