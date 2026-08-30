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

export function extractAgenciaBrasilImages(html: string, pageUrl: string): PageImageCandidate[] {
  const document = load(html);
  const body = document(".field--name-body").first();
  if (!body.length) return [];
  const images: PageImageCandidate[] = [];
  const seen = new Set<string>();
  const leadUrl = absoluteUrl(
    document("meta[property='og:image']").attr("content")
      ?? document("meta[name='twitter:image']").attr("content"),
    pageUrl,
  );
  if (leadUrl) {
    const alt = normalizedText(document("meta[property='og:image:alt']").attr("content") ?? "") || undefined;
    const width = dimension(document("meta[property='og:image:width']").attr("content"));
    const height = dimension(document("meta[property='og:image:height']").attr("content"));
    images.push({
      sourceUrl: leadUrl,
      role: "lead",
      ...(alt ? { alt } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    });
    seen.add(leadUrl);
  }

  const seenBlocks = new Set<string>();
  let blockCount = 0;
  body.find("p,h2,h3,h4,blockquote,ul,ol,pre,img").each((_, element) => {
    const node = document(element);
    if (node.closest("aside,[class*='advert'],[class*='related'],[class*='recommend'],[class*='share']").length) return;
    if (!node.is("img")) {
      if (node.closest("figure,figcaption").length || node.parents("p,h2,h3,h4,blockquote,ul,ol,pre").length) return;
      const text = normalizedText(node.text());
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
    if (/(?:logo|icon|avatar|tracking|pixel|sprite|placeholder|advert|banner)/iu.test(`${sourceUrl} ${alt ?? ""}`)) return;
    const figure = node.closest("figure");
    const caption = normalizedText(
      figure.find("figcaption").first().text()
        || node.closest(".media,.field--type-image").find(".field--name-field-caption,.caption").first().text(),
    ) || undefined;
    seen.add(sourceUrl);
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
