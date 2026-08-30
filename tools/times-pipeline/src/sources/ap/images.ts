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

function firstSrcsetUrl(value: string | undefined, pageUrl: string): string | undefined {
  return absoluteUrl(value?.split(",")[0]?.trim().split(/\s+/u)[0], pageUrl);
}

function dimension(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function extractApImages(html: string, pageUrl: string): PageImageCandidate[] {
  const document = load(html);
  const images: PageImageCandidate[] = [];
  const seen = new Set<string>();
  document(".Carousel-slide > .CarouselSlide").each((_, element) => {
    const slide = document(element);
    const image = slide.find("img").first();
    if (!image.length) return;
    const desktopSource = slide.find("source[media*='1024']:not([type])").first();
    const sourceUrl = firstSrcsetUrl(
      desktopSource.attr("data-flickity-lazyload-srcset")
        ?? image.attr("data-flickity-lazyload-srcset")
        ?? image.attr("srcset"),
      pageUrl,
    ) ?? absoluteUrl(image.attr("data-flickity-lazyload") ?? image.attr("src"), pageUrl);
    if (!sourceUrl || seen.has(sourceUrl)) return;
    seen.add(sourceUrl);
    const alt = image.attr("alt")?.replaceAll(/\s+/gu, " ").trim() || undefined;
    const width = dimension(desktopSource.attr("width") ?? image.attr("width"));
    const height = dimension(desktopSource.attr("height") ?? image.attr("height"));
    images.push({
      sourceUrl,
      role: images.length ? "content" : "lead",
      ...(images.length ? { afterBlock: 0 } : {}),
      ...(alt ? { alt, caption: alt } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    });
  });
  return images.map((image, order) => ({
    ...image,
    presentation: {
      type: "carousel",
      id: "ap-primary-gallery",
      order,
      total: images.length,
    },
  }));
}
