import { load } from "cheerio";
import type { PageImageCandidate } from "../../capture/page-images.js";
import { boundedThepaperBody } from "./process.js";

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

export function extractThepaperImages(html: string, pageUrl: string): PageImageCandidate[] {
  const body = boundedThepaperBody(html);
  if (!body) return [];
  const document = load(body, undefined, false);
  const images: PageImageCandidate[] = [];
  const seenBlocks = new Set<string>();
  let blockCount = 0;
  document("p,h2,h3,h4,blockquote,ul,ol,pre,img").each((_index, element) => {
    const node = document(element);
    if (node.is("img")) {
      const sourceUrl = absoluteUrl(node.attr("data-src") ?? node.attr("src"), pageUrl);
      if (!sourceUrl) return;
      const wrapper = node.closest("figure,p,div").first();
      const anchor = wrapper.length ? wrapper : node;
      const explicitCaption = anchor.next(".image_desc,[class*='caption']").first().text().replaceAll(/\s+/gu, " ").trim() || undefined;
      const alt = node.attr("alt")?.replaceAll(/\s+/gu, " ").trim() || explicitCaption;
      const width = dimension(node.attr("width") ?? node.attr("data-width"));
      const height = dimension(node.attr("height") ?? node.attr("data-height"));
      images.push({
        sourceUrl,
        role: "content",
        afterBlock: blockCount,
        ...(alt ? { alt } : {}),
        ...(explicitCaption ? { caption: explicitCaption } : {}),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
      });
      return;
    }
    if (node.find("img").length || node.is(".image_desc,.video_desc,[class*='caption']")) return;
    if (!node.is("p,h2,h3,h4,blockquote,ul,ol,pre")) return;
    const text = node.text().replaceAll(/\s+/gu, " ").trim();
    const structural = node.is("h2,h3,h4,ul,ol");
    if (text && (structural || text.length >= 20) && !seenBlocks.has(text)) {
      seenBlocks.add(text);
      blockCount += 1;
    }
  });
  return images;
}
