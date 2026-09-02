import { load } from "cheerio";
import type { PageImageCandidate } from "../../capture/page-images.js";
import { embeddedClsBody } from "./process.js";

const BODY_SELECTORS = [".detail-content", ".article-content", "[itemprop='articleBody']", "article"] as const;

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

function renderedClsBody(html: string): string | undefined {
  const page = load(html);
  for (const selector of BODY_SELECTORS) {
    const body = page(selector).first();
    const value = body.html()?.trim();
    if (value) return value;
  }
  return undefined;
}

export function extractClsImages(html: string, pageUrl: string): PageImageCandidate[] {
  const content = embeddedClsBody(html) ?? renderedClsBody(html);
  if (!content) return [];
  const document = load(content, undefined, false);
  const images: PageImageCandidate[] = [];
  const seen = new Set<string>();
  const seenBlocks = new Set<string>();
  let blockCount = 0;
  document("p,h2,h3,h4,blockquote,ul,ol,img").each((_index, element) => {
    const node = document(element);
    if (node.closest("aside,[class*='advert'],[class*='recommend'],[class*='related'],[class*='share']").length) return;
    if (node.is("img")) {
      const sourceUrl = absoluteUrl(node.attr("data-src") ?? node.attr("data-original") ?? node.attr("src"), pageUrl);
      if (!sourceUrl || seen.has(sourceUrl)) return;
      seen.add(sourceUrl);
      const wrapper = node.closest("figure,p,div").first();
      const explicitCaption = wrapper.find("figcaption").first().text().replaceAll(/\s+/gu, " ").trim()
        || wrapper.next(".image_desc,[class*='caption']").first().text().replaceAll(/\s+/gu, " ").trim()
        || undefined;
      const alt = node.attr("alt")?.replaceAll(/\s+/gu, " ").trim();
      const meaningfulAlt = alt && alt.toLowerCase() !== "image" ? alt : explicitCaption;
      const width = dimension(node.attr("width"));
      const height = dimension(node.attr("height"));
      images.push({
        sourceUrl,
        role: "content",
        afterBlock: blockCount,
        ...(meaningfulAlt ? { alt: meaningfulAlt } : {}),
        ...(explicitCaption ? { caption: explicitCaption } : {}),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
      });
      return;
    }
    if (node.find("img").length || node.is(".image_desc,[class*='caption']")) return;
    const text = node.text().replaceAll(/\s+/gu, " ").trim();
    if (!text) return;
    const structural = node.is("h2,h3,h4,ul,ol") || (node.is("p") && text.length < 48 && node.find("strong,b").length > 0);
    if ((structural || text.length >= 20) && !seenBlocks.has(text)) {
      seenBlocks.add(text);
      blockCount += 1;
    }
  });
  return images;
}
