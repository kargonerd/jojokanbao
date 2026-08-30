import { load } from "cheerio";
import type { PageImageCandidate } from "../../capture/page-images.js";
import { isPeopleResidualPage } from "./process.js";

const PHOTO_CAPTION = /(?:人民网(?:记者)?[^。]{0,50}摄|(?:记者|摄影)[^。]{0,40}摄)(?:[）)]|$)/u;

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

export function extractPeopleImages(html: string, pageUrl: string): PageImageCandidate[] {
  const document = load(html);
  const container = ["#rm_txt_zw", "#rwb_zw", ".rm_txt_con"]
    .map((selector) => document(selector).first())
    .find((candidate) => candidate.length > 0);
  if (!container) return [];
  const semanticContainer = container.clone();
  semanticContainer.find("script,style,noscript,.paper_num,[class*='share'],[class*='recommend']").remove();
  if (isPeopleResidualPage(semanticContainer.text(), semanticContainer.find("p,h2,h3,h4,blockquote,ul,ol").length)) {
    return [];
  }
  const captionNodes = new Set<unknown>();
  const captionByImage = new Map<unknown, string>();
  container.find("img").each((_index, element) => {
    const image = document(element);
    const wrapper = image.closest("p,figure,div").first();
    const next = wrapper.nextAll("p").first();
    const caption = text(next.text());
    const alt = text(image.attr("alt") ?? "");
    if (caption && ((alt && caption === alt) || PHOTO_CAPTION.test(caption))) {
      captionNodes.add(next.get(0));
      captionByImage.set(element, caption);
    }
  });

  const images: PageImageCandidate[] = [];
  const seen = new Set<string>();
  const seenBlocks = new Set<string>();
  let blockCount = 0;
  container.find("p,h2,h3,h4,blockquote,ul,ol,img").each((_index, element) => {
    const node = document(element);
    if (node.is("img")) {
      if (node.closest(".paper_num,[class*='share'],[class*='recommend']").length) return;
      const sourceUrl = absoluteUrl(node.attr("data-src") ?? node.attr("data-original") ?? node.attr("src"), pageUrl);
      const width = dimension(node.attr("width"));
      const height = dimension(node.attr("height"));
      if (!sourceUrl || seen.has(sourceUrl) || /\/(?:share|logo|icon)[^/]*\.(?:png|jpe?g|gif|webp)$/iu.test(new URL(sourceUrl).pathname)
        || (width !== undefined && width <= 80) || (height !== undefined && height <= 80)) return;
      seen.add(sourceUrl);
      const caption = captionByImage.get(element);
      const alt = text(node.attr("alt") ?? "") || caption;
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
    if (node.find("img").length || captionNodes.has(element)
      || node.closest(".paper_num,[class*='share'],[class*='recommend']").length) return;
    const value = text(node.text());
    if (!value) return;
    const structural = node.is("h2,h3,h4,ul,ol") || (node.is("p") && value.length < 48 && node.find("strong,b").length > 0);
    if ((structural || value.length >= 20) && !seenBlocks.has(value)) {
      seenBlocks.add(value);
      blockCount += 1;
    }
  });
  return images;
}
