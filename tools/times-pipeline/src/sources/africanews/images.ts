import { load } from "cheerio";
import type { PageImageCandidate } from "../../capture/page-images.js";

const BLOCK_SELECTOR = "p,h2,h3,h4,blockquote,ul,ol,pre";
const TRAILING_HEADING = /^(?:Related articles|More (?:from|on)\b.*)$/iu;

function absoluteUrl(value: string | undefined, pageUrl: string): string | undefined {
  if (!value || value.startsWith("data:") || value.startsWith("blob:")) return undefined;
  try {
    const url = new URL(value, pageUrl);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function bestSrcsetUrl(value: string | undefined, pageUrl: string): string | undefined {
  return value?.split(",").map((entry, index) => {
    const [rawUrl, descriptor] = entry.trim().split(/\s+/u);
    const url = absoluteUrl(rawUrl, pageUrl);
    if (!url) return undefined;
    const parsed = descriptor?.match(/^(\d+(?:\.\d+)?)(w|x)$/u);
    const score = parsed ? Number(parsed[1]) * (parsed[2] === "x" ? 10_000 : 1) : index;
    return { url, score };
  }).filter((value): value is { url: string; score: number } => Boolean(value))
    .toSorted((left, right) => right.score - left.score)[0]?.url;
}

function dimension(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizedText(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

export function extractAfricanewsImages(html: string, pageUrl: string): PageImageCandidate[] {
  const document = load(html);
  const container = document(".article-content__text").first().length
    ? document(".article-content__text").first()
    : document(".article-content").first().length
      ? document(".article-content").first()
      : document(".article__body").first();
  if (!container.length) return [];
  const images: PageImageCandidate[] = [];
  const seen = new Set<string>();
  const leadUrl = absoluteUrl(
    document("meta[property='og:image']").attr("content")
      ?? document("meta[name='twitter:image']").attr("content"),
    pageUrl,
  );
  if (leadUrl) {
    const captionNode = document("header.article__header .c-article-media-copyright").first().clone();
    const creditNode = captionNode.find(".c-article__copyright").first();
    const credit = normalizedText(creditNode.text()) || undefined;
    creditNode.remove();
    const description = normalizedText(captionNode.text()).replace(/^[-|–—:]+|[-|–—:]+$/gu, "").trim() || undefined;
    const caption = [description, credit].filter(Boolean).join(" ") || undefined;
    const alt = normalizedText(document("meta[property='og:image:alt']").attr("content") ?? "") || undefined;
    const width = dimension(document("meta[property='og:image:width']").attr("content"));
    const height = dimension(document("meta[property='og:image:height']").attr("content"));
    images.push({
      sourceUrl: leadUrl,
      role: "lead",
      ...(alt ? { alt } : {}),
      ...(caption ? { caption } : {}),
      ...(credit ? { credit } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    });
    seen.add(leadUrl);
  }

  const seenBlocks = new Set<string>();
  let blockCount = 0;
  container.find(`${BLOCK_SELECTOR},img`).each((_, element) => {
    const node = document(element);
    if (node.closest("aside,.advertising,[class*='related']").length) return;
    if (!node.is("img")) {
      const text = normalizedText(node.text());
      if (node.is("h2,h3,h4") && TRAILING_HEADING.test(text)) return false;
      if (node.closest("figure,figcaption").length || node.parents(BLOCK_SELECTOR).length) return;
      if (text && (node.is("h2,h3,h4") || text.length >= 20) && !seenBlocks.has(text)) {
        seenBlocks.add(text);
        blockCount += 1;
      }
      return;
    }
    const sourceUrl = bestSrcsetUrl(node.attr("data-srcset") ?? node.attr("srcset"), pageUrl)
      ?? absoluteUrl(node.attr("data-src") ?? node.attr("data-original") ?? node.attr("src"), pageUrl);
    if (!sourceUrl || seen.has(sourceUrl)) return;
    const width = dimension(node.attr("width"));
    const height = dimension(node.attr("height"));
    const alt = normalizedText(node.attr("alt") ?? "") || undefined;
    if ((width !== undefined && width <= 80) || (height !== undefined && height <= 80)) return;
    if (/(?:logo|icon|avatar|tracking|pixel|sprite|placeholder|advert)/iu.test(`${sourceUrl} ${alt ?? ""}`)) return;
    seen.add(sourceUrl);
    const caption = normalizedText(node.closest("figure").find("figcaption").first().text()) || undefined;
    images.push({
      sourceUrl,
      role: "content",
      afterBlock: blockCount,
      ...(alt ? { alt } : {}),
      ...(caption ? { caption } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    });
  });
  return images;
}
