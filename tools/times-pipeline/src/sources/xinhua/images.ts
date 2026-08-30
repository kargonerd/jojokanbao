import { load } from "cheerio";
import type { PageImageCandidate } from "../../capture/page-images.js";
import { isXinhuaResidualPage } from "./process.js";

const PHOTO_CREDIT = /(?:新华社(?:记者|发)?[^。；]{0,60}(?:摄|图)|(?:记者|摄影)[^。；]{0,40}摄)/u;

function normalizedText(value: string): string {
  return value.replaceAll(/pagebreak/giu, " ").replaceAll(/\s+/gu, " ").trim();
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

export function extractXinhuaImages(html: string, pageUrl: string): PageImageCandidate[] {
  const document = load(html);
  const container = document("#detailContent").first();
  if (!container.length) return [];
  if (isXinhuaResidualPage(container.text(), container.find("p,h2,h3,h4,blockquote").length)) return [];
  const images: PageImageCandidate[] = [];
  const seen = new Set<string>();
  const captionNodes = new Set<unknown>();
  const seenBlocks = new Set<string>();
  let blockCount = 0;

  container.find("p,h2,h3,h4,blockquote,img").each((_index, element) => {
    const node = document(element);
    if (node.is("img")) {
      const sourceUrl = absoluteUrl(node.attr("data-src") ?? node.attr("src"), pageUrl);
      if (!sourceUrl || seen.has(sourceUrl)) return;
      seen.add(sourceUrl);
      const wrapper = node.closest("p,figure,div").first();
      const following: Array<ReturnType<typeof document>> = [];
      for (let sibling = wrapper.next(); sibling.length && !sibling.find("img").length; sibling = sibling.next()) {
        if (!sibling.is("p")) break;
        if (normalizedText(sibling.text())) following.push(sibling);
      }
      const credit = following.find((candidate) => PHOTO_CREDIT.test(normalizedText(candidate.text())));
      const description = credit ? following[0] : undefined;
      if (description) captionNodes.add(description.get(0));
      if (credit) captionNodes.add(credit.get(0));
      const captionParts = [description, credit]
        .filter((candidate, index, values) => Boolean(candidate) && values.indexOf(candidate) === index)
        .map((candidate) => normalizedText(candidate!.text()));
      const caption = captionParts.join(" ") || undefined;
      const alt = normalizedText(node.attr("alt") ?? "") || caption;
      const width = dimension(node.attr("width") ?? node.attr("data-width"));
      const height = dimension(node.attr("height") ?? node.attr("data-height"));
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
    if (node.find("img").length || captionNodes.has(element)) return;
    const text = normalizedText(node.text());
    if (!text) return;
    const structural = node.is("h2,h3,h4") || (node.is("p") && text.length < 48 && node.find("strong,b").length > 0);
    if ((structural || text.length >= 20) && !seenBlocks.has(text)) {
      seenBlocks.add(text);
      blockCount += 1;
    }
  });
  const pageBreaks = container.find("b").filter((_index, element) =>
    document(element).text().replaceAll(/\s+/gu, "").toLowerCase() === "pagebreak").length;
  if (images.length > 1 && pageBreaks >= images.length - 1) {
    return images.map((image, order) => ({
      ...image,
      presentation: {
        type: "carousel" as const,
        id: "xinhua-primary-gallery",
        order,
        total: images.length,
      },
    }));
  }
  return images;
}
