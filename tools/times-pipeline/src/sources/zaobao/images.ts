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

function isZaobaoArticleImage(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === "cassette.sphdigital.com.sg" && url.pathname.startsWith("/image/zaobao/");
  } catch {
    return false;
  }
}

function dimension(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function extractZaobaoImages(html: string, pageUrl: string): PageImageCandidate[] {
  const document = load(html);
  const article = document("article").first();
  if (!article.length) return [];
  const body = article.find(".articleBody").first();
  const images: PageImageCandidate[] = [];
  const seenUrls = new Set<string>();
  const add = (image: ReturnType<typeof document>, role: "lead" | "content", afterBlock?: number): void => {
    if (image.closest(".bff-recommend-article,[class*='recommend']").length) return;
    const sourceUrl = absoluteUrl(image.attr("data-src") ?? image.attr("data-original") ?? image.attr("src"), pageUrl);
    if (!sourceUrl || !isZaobaoArticleImage(sourceUrl) || seenUrls.has(sourceUrl)) return;
    seenUrls.add(sourceUrl);
    const container = image.closest(".inline-figure,figure");
    const alt = image.attr("alt")?.replaceAll(/\s+/gu, " ").trim() || undefined;
    const explicitCaption = container.find("figcaption,[class*='caption']").first().text().replaceAll(/\s+/gu, " ").trim() || undefined;
    const caption = explicitCaption ?? alt;
    const width = dimension(image.attr("width"));
    const height = dimension(image.attr("height"));
    images.push({
      sourceUrl,
      role,
      ...(alt ? { alt } : {}),
      ...(caption ? { caption } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(afterBlock !== undefined ? { afterBlock } : {}),
    });
  };

  const lead = article.find("img").filter((_, element) => {
    const image = document(element);
    if (image.closest(".articleBody,.bff-recommend-article,[class*='recommend']").length) return false;
    const sourceUrl = absoluteUrl(image.attr("data-src") ?? image.attr("data-original") ?? image.attr("src"), pageUrl);
    return Boolean(sourceUrl && isZaobaoArticleImage(sourceUrl));
  }).first();
  if (lead.length) add(lead, "lead");

  if (!body.length) return images;
  const inlineFigures = new Set(body.find(".inline-figure").toArray());
  body.find(".bff-inline-image").each((_, element) => {
    if (!document(element).closest(".inline-figure").length) inlineFigures.add(element);
  });
  const seenBlocks = new Set<string>();
  let blockCount = 0;
  body.find("*").each((_, element) => {
    const node = document(element);
    if (inlineFigures.has(element)) {
      const image = node.find("img").first();
      if (image.length) add(image, "content", blockCount);
      return;
    }
    if (node.closest(".inline-figure,.bff-inline-image,.bff-recommend-article,[class*='recommend']").length) return;
    if (!node.is("p,h2,h3,h4,blockquote,ul,ol")) return;
    const text = node.text().replaceAll(/\s+/gu, " ").trim();
    const heading = node.is("h2,h3,h4");
    if (text && (heading || text.length >= 20) && !seenBlocks.has(text)) {
      seenBlocks.add(text);
      blockCount += 1;
    }
  });
  return images;
}
