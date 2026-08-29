import { load } from "cheerio";
import type { PageImageCandidate } from "../../capture/page-images.js";

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

export function extractCnaImages(html: string, pageUrl: string): PageImageCandidate[] {
  const document = load(html);
  const article = document("article.node--article-content").first();
  if (!article.length) return [];
  const figures = new Set(article.find([
    "figure.detail-hero-media",
    "section.block-field-blocknodearticlefield-content figure",
  ].join(",")).toArray());
  const images: PageImageCandidate[] = [];
  const seenBlocks = new Set<string>();
  let blockCount = 0;
  article.find("*").each((_, element) => {
    const node = document(element);
    if (figures.has(element)) {
      const image = node.find("img").first();
      const sourceUrl = absoluteUrl(
        image.attr("data-src") ?? image.attr("data-original") ?? image.attr("src"),
        pageUrl,
      );
      if (!sourceUrl) return;
      const captionNode = node.find("figcaption").first().clone();
      captionNode.find("a.more").remove();
      captionNode.find("span").filter((_, span) => /^\s*…\s*$/u.test(document(span).text())).remove();
      const caption = captionNode.text().replaceAll(/\s+/gu, " ").trim() || undefined;
      const alt = image.attr("alt")?.trim() || undefined;
      const picture = image.closest("picture");
      const width = dimension(image.attr("width") ?? picture.attr("width"));
      const height = dimension(image.attr("height") ?? picture.attr("height"));
      const lead = node.hasClass("detail-hero-media");
      images.push({
        sourceUrl,
        role: lead ? "lead" : "content",
        ...(alt ? { alt } : {}),
        ...(caption ? { caption } : {}),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        ...(!lead ? { afterBlock: blockCount } : {}),
      });
      return;
    }
    if (node.is("p,h2,h3,h4,blockquote,ul,ol")
      && node.closest("section.block-field-blocknodearticlefield-content .text-long").length
      && !node.closest("figure").length) {
      const text = node.text().replaceAll(/\s+/gu, " ").trim();
      const heading = node.is("h2,h3,h4");
      if (text && (heading || text.length >= 20) && !seenBlocks.has(text)) {
        seenBlocks.add(text);
        blockCount += 1;
      }
    }
  });
  return images;
}
