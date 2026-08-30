import { load } from "cheerio";
import type { JojoAssetPresentation } from "@jojo/content";
import type { SourceFetchPolicy } from "../types.js";

export interface PageImageCandidate {
  sourceUrl: string;
  role: "lead" | "content";
  alt?: string;
  caption?: string;
  width?: number;
  height?: number;
  afterBlock?: number;
  credit?: string;
  presentation?: JojoAssetPresentation;
}

export type ArticleImageExtractor = (html: string, pageUrl: string) => PageImageCandidate[];

function absoluteImageUrl(value: string | undefined, pageUrl: string): string | undefined {
  if (!value || value.startsWith("data:") || value.startsWith("blob:")) return undefined;
  try {
    const url = new URL(value, pageUrl);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function srcsetUrl(value: string | undefined): string | undefined {
  return value?.split(",").map((entry) => entry.trim().split(/\s+/u)[0]).filter(Boolean).at(-1);
}

function ignoredImage(url: string, alt: string, width?: number, height?: number): boolean {
  if ((width !== undefined && width <= 80) || (height !== undefined && height <= 80)) return true;
  return /(?:logo|avatar|icon|sprite|pixel|tracking|badge|author|profile|advert|promo|placeholder)/iu.test(`${url} ${alt}`);
}

function precedingBodyBlockCount(
  document: ReturnType<typeof load>,
  image: ReturnType<ReturnType<typeof load>>,
  containerSelectors: readonly string[],
): number | undefined {
  const container = image.closest(containerSelectors.join(",")).first();
  if (!container.length) return undefined;
  const seen = new Set<string>();
  let count = 0;
  let reachedImage = false;
  container.find("p,h2,h3,h4,blockquote,ul,ol,pre,img").each((_index, element) => {
    if (element === image.get(0)) {
      reachedImage = true;
      return false;
    }
    const node = document(element);
    if (node.is("img") || node.closest("figure").length) return;
    const text = node.text().replaceAll(/\s+/gu, " ").trim();
    const structural = node.is("h2,h3,h4,ul,ol");
    if (text && (structural || text.length >= 20) && !seen.has(text)) {
      seen.add(text);
      count += 1;
    }
  });
  return reachedImage ? count : undefined;
}

export function discoverArticleImages(
  html: string,
  pageUrl: string,
  policy?: SourceFetchPolicy,
  sourceExtractor?: ArticleImageExtractor,
): PageImageCandidate[] {
  const $ = load(html);
  const values = new Map<string, PageImageCandidate>();
  const add = (candidate: PageImageCandidate): void => {
    if (!ignoredImage(candidate.sourceUrl, candidate.alt ?? "", candidate.width, candidate.height)) {
      const previous = values.get(candidate.sourceUrl);
      const alt = candidate.alt ?? previous?.alt;
      const caption = candidate.caption ?? previous?.caption;
      const credit = candidate.credit ?? previous?.credit;
      values.set(candidate.sourceUrl, {
        ...previous,
        ...candidate,
        role: previous?.role === "lead" || candidate.role === "lead" ? "lead" : "content",
        ...(alt ? { alt } : {}),
        ...(caption ? { caption } : {}),
        ...(credit ? { credit } : {}),
      });
    }
  };
  const publisherImages = sourceExtractor?.(html, pageUrl) ?? [];
  if (publisherImages.length) {
    for (const candidate of publisherImages) add(candidate);
    return [...values.values()];
  }
  const lead = absoluteImageUrl($("meta[property='og:image']").attr("content") ?? $("meta[name='twitter:image']").attr("content"), pageUrl);
  if (lead) add({ sourceUrl: lead, role: "lead" });
  const selectors = policy?.imageSelectors?.length
    ? policy.imageSelectors
    : [...(policy?.bodySelectors ?? []), "[itemprop='articleBody']", "article", ".article-body", ".article__body", ".story-body", ".entry-content", "main"];
  const selectedSelectors = policy?.imageSelectors?.length
    ? selectors.filter((selector) => $(selector).length > 0)
    : selectors.filter((selector) => $(selector).length > 0).slice(0, 1);
  const containers = selectedSelectors.length ? $(selectedSelectors.join(",")) : $("body");
  const images = containers.filter("img").add(containers.find("img"));
  images.each((_index, element) => {
    const image = $(element);
    if (image.closest("nav,header,footer,aside,[class*='advert'],[class*='recommend'],[class*='share']").length) return;
    const sourceUrl = absoluteImageUrl(
      image.attr("data-src") ?? image.attr("data-original") ?? image.attr("src") ?? srcsetUrl(image.attr("srcset")),
      pageUrl,
    );
    if (!sourceUrl) return;
    const figure = image.closest("figure");
    const alt = image.attr("alt")?.trim() || undefined;
    const caption = figure.find("figcaption").first().text().replaceAll(/\s+/gu, " ").trim() || undefined;
    const width = Number(image.attr("width")) || undefined;
    const height = Number(image.attr("height")) || undefined;
    const role = sourceUrl === lead ? "lead" : "content";
    const afterBlock = role === "content" ? precedingBodyBlockCount($, image, selectors) : undefined;
    add({ sourceUrl, role, ...(alt ? { alt } : {}), ...(caption ? { caption } : {}), ...(width ? { width } : {}), ...(height ? { height } : {}), ...(afterBlock !== undefined ? { afterBlock } : {}) });
  });
  return [...values.values()];
}
