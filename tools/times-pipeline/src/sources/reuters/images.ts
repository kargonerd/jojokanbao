import type { PageImageCandidate } from "../../capture/page-images.js";
import { reutersFusionResult, reutersObject, type ReutersJsonObject } from "./fusion.js";

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function deliveryImage(value: ReutersJsonObject): { sourceUrl?: string; width?: number; height?: number } {
  const originalWidth = number(value.width);
  const originalHeight = number(value.height);
  const resizer = string(value.resizer_url);
  if (!resizer) {
    const sourceUrl = string(value.url);
    return {
      ...(sourceUrl ? { sourceUrl } : {}),
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
    const sourceUrl = string(value.url);
    return {
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(originalWidth ? { width: originalWidth } : {}),
      ...(originalHeight ? { height: originalHeight } : {}),
    };
  }
}

function imageCandidate(value: unknown, role: "lead" | "content", afterBlock?: number): PageImageCandidate | undefined {
  const image = reutersObject(value);
  if (image?.type !== "image") return undefined;
  const delivered = deliveryImage(image);
  const sourceUrl = delivered.sourceUrl;
  if (!sourceUrl) return undefined;
  const alt = string(image.alt_text) ?? string(image.subtitle);
  const caption = string(image.caption);
  const credit = string(image.authors) ?? string(image.company);
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

export function extractReutersImages(html: string): PageImageCandidate[] {
  const result = reutersFusionResult(html);
  if (!result) return [];
  const gallery = galleryImages(result);
  const values = gallery.length
    ? gallery
    : [reutersObject(result.promo_items)?.images, result.thumbnail]
      .flatMap((value) => Array.isArray(value) ? value : [value]);
  const images: PageImageCandidate[] = [];
  for (const value of values) {
    const candidate = imageCandidate(value, images.length ? "content" : "lead", images.length ? 0 : undefined);
    if (candidate && !images.some((image) => image.sourceUrl === candidate.sourceUrl)) images.push(candidate);
  }
  return images;
}
