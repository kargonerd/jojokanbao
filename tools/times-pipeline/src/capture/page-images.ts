import { load } from "cheerio";
import type { SourceFetchPolicy } from "../types.js";

export interface PageImageCandidate {
  sourceUrl: string;
  role: "lead" | "content";
  alt?: string;
  caption?: string;
  width?: number;
  height?: number;
}

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

export function discoverArticleImages(html: string, pageUrl: string, policy?: SourceFetchPolicy): PageImageCandidate[] {
  const $ = load(html);
  const values = new Map<string, PageImageCandidate>();
  const add = (candidate: PageImageCandidate): void => {
    if (!ignoredImage(candidate.sourceUrl, candidate.alt ?? "", candidate.width, candidate.height)) {
      const previous = values.get(candidate.sourceUrl);
      values.set(candidate.sourceUrl, previous?.role === "lead" ? previous : candidate);
    }
  };
  const lead = absoluteImageUrl($("meta[property='og:image']").attr("content") ?? $("meta[name='twitter:image']").attr("content"), pageUrl);
  if (lead) add({ sourceUrl: lead, role: "lead" });
  const selectors = [...(policy?.bodySelectors ?? []), "[itemprop='articleBody']", "article", ".article-body", ".article__body", ".story-body", ".entry-content", "main"];
  const selectedSelector = selectors.find((selector) => $(selector).length > 0);
  const containers = selectedSelector ? $(selectedSelector) : $("body");
  const images = containers.length ? containers.find("img") : $("img");
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
    add({ sourceUrl, role: sourceUrl === lead ? "lead" : "content", ...(alt ? { alt } : {}), ...(caption ? { caption } : {}), ...(width ? { width } : {}), ...(height ? { height } : {}) });
  });
  return [...values.values()];
}
