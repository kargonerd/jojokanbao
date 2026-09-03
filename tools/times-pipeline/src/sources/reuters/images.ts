import type { PageImageCandidate } from "../../capture/page-images.js";
import { reutersFusionResult, reutersObject, type ReutersJsonObject } from "./fusion.js";

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function absoluteUrl(value: unknown, pageUrl: string): string | undefined {
  const source = string(value);
  if (!source || source.startsWith("data:") || source.startsWith("blob:")) return undefined;
  try {
    const url = new URL(source, pageUrl);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function deliveryImage(value: ReutersJsonObject, pageUrl: string): { sourceUrl?: string; width?: number; height?: number } {
  const originalWidth = number(value.width);
  const originalHeight = number(value.height);
  const originalUrl = absoluteUrl(value.url, pageUrl);
  const resizer = absoluteUrl(value.resizer_url, pageUrl);
  if (!resizer) {
    return {
      ...(originalUrl ? { sourceUrl: originalUrl } : {}),
      ...(originalWidth ? { width: originalWidth } : {}),
      ...(originalHeight ? { height: originalHeight } : {}),
    };
  }
  try {
    const url = new URL(resizer);
    url.searchParams.delete("height");
    url.searchParams.delete("smart");
    url.searchParams.set("width", "1920");
    url.searchParams.set("quality", "85");
    return {
      sourceUrl: url.toString(),
      width: 1920,
      ...(originalWidth && originalHeight ? { height: Math.round(originalHeight * 1920 / originalWidth) } : {}),
    };
  } catch {
    return {
      ...(originalUrl ? { sourceUrl: originalUrl } : {}),
      ...(originalWidth ? { width: originalWidth } : {}),
      ...(originalHeight ? { height: originalHeight } : {}),
    };
  }
}

function imageCandidate(
  value: unknown,
  pageUrl: string,
  role: "lead" | "content",
  afterBlock?: number,
): PageImageCandidate | undefined {
  const image = reutersObject(value);
  if (image?.type !== "image") return undefined;
  if (string(image.subtitle)?.toUpperCase() === "TOPIC:DEFAULT_TOPIC_THUMBNAIL") return undefined;
  const delivered = deliveryImage(image, pageUrl);
  const sourceUrl = delivered.sourceUrl;
  if (!sourceUrl) return undefined;
  const alt = string(image.alt_text) ?? string(image.subtitle);
  const credit = string(image.authors) ?? string(image.company);
  const description = string(image.caption);
  const caption = [...new Set([description, credit].filter((value): value is string => Boolean(value)))].join(" ") || undefined;
  const width = delivered.width;
  const height = delivered.height;
  return {
    sourceUrl,
    role,
    ...(alt ? { alt } : {}),
    ...(caption ? { caption } : {}),
    ...(credit ? { credit } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(afterBlock !== undefined ? { afterBlock } : {}),
  };
}

function galleryImages(result: ReutersJsonObject): unknown[] {
  const related = reutersObject(result.related_content);
  const galleries = Array.isArray(related?.galleries) ? related.galleries : [];
  return galleries.flatMap((value) => {
    const gallery = reutersObject(value);
    return Array.isArray(gallery?.content_elements) ? gallery.content_elements : [];
  });
}

export function extractReutersImages(html: string, pageUrl = "https://www.reuters.com/"): PageImageCandidate[] {
  const result = reutersFusionResult(html);
  if (!result) return [];
  const gallery = galleryImages(result);
  const values = gallery.length
    ? gallery
    : [reutersObject(result.promo_items)?.images, result.thumbnail]
      .flatMap((value) => Array.isArray(value) ? value : [value]);
  const images: PageImageCandidate[] = [];
  for (const value of values) {
    const candidate = imageCandidate(value, pageUrl, images.length ? "content" : "lead", images.length ? 0 : undefined);
    if (candidate && !images.some((image) => image.sourceUrl === candidate.sourceUrl)) images.push(candidate);
  }
  if (!gallery.length || images.length < 2) return images;
  return images.map((image, order) => ({
    ...image,
    presentation: {
      type: "carousel",
      id: "reuters-primary-gallery",
      order,
      total: images.length,
    },
  }));
}
