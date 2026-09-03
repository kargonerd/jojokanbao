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

function normalizedText(value: string | undefined): string | undefined {
  return value?.replaceAll(/\s+/gu, " ").trim() || undefined;
}

function dimension(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function extractApImages(html: string, pageUrl: string): PageImageCandidate[] {
  const document = load(html);
  const images: PageImageCandidate[] = [];
  const seen = new Set<string>();

  const add = (
    container: ReturnType<ReturnType<typeof load>>,
    placement: {
      role: "lead" | "content";
      afterBlock?: number;
      carousel?: { order: number; total: number };
    },
  ): void => {
    const image = container.is("img") ? container : container.find("img").first();
    if (!image.length) return;
    const sources = container.find("source").toArray().map((element) => {
      const source = document(element);
      const sourceUrl = firstSrcsetUrl(
        source.attr("data-flickity-lazyload-srcset") ?? source.attr("srcset"),
        pageUrl,
      );
      return {
        sourceUrl,
        width: dimension(source.attr("width")),
        height: dimension(source.attr("height")),
      };
    }).filter((candidate) => candidate.sourceUrl)
      .sort((left, right) => (right.width ?? 0) - (left.width ?? 0));
    const selectedSource = sources[0];
    const sourceUrl = selectedSource?.sourceUrl
      ?? firstSrcsetUrl(image.attr("data-flickity-lazyload-srcset") ?? image.attr("srcset"), pageUrl)
      ?? absoluteUrl(image.attr("data-flickity-lazyload") ?? image.attr("src"), pageUrl);
    if (!sourceUrl || seen.has(sourceUrl)) return;
    seen.add(sourceUrl);
    const alt = normalizedText(image.attr("alt"));
    const caption = normalizedText(
      container.find("figcaption").first().text()
        || container.closest("figure").find("figcaption").first().text(),
    ) ?? alt;
    const width = selectedSource?.width ?? dimension(image.attr("width"));
    const height = selectedSource?.height ?? dimension(image.attr("height"));
    images.push({
      sourceUrl,
      role: placement.role,
      ...(placement.afterBlock !== undefined ? { afterBlock: placement.afterBlock } : {}),
      ...(alt ? { alt } : {}),
      ...(caption ? { caption } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(placement.carousel ? {
        presentation: {
          type: "carousel",
          id: "ap-primary-gallery",
          order: placement.carousel.order,
          total: placement.carousel.total,
        },
      } : {}),
    });
  };

  const lead = document(".Page-lead").first();
  if (lead.length) {
    const slides = lead.find(".Carousel-slide > .CarouselSlide");
    if (slides.length) {
      slides.each((order, element) => add(document(element), {
        role: order ? "content" : "lead",
        ...(order ? { afterBlock: 0 } : {}),
        carousel: { order, total: slides.length },
      }));
    } else {
      lead.find("figure").each((order, element) => add(document(element), {
        role: order ? "content" : "lead",
        ...(order ? { afterBlock: 0 } : {}),
      }));
    }
  }

  // AP's current single-image stories use a standalone Page-lead figure. If
  // that markup is absent, the publisher metadata remains story-owned and is
  // safer than scanning recommendation carousels elsewhere on the page.
  if (!images.length) {
    const sourceUrl = absoluteUrl(
      document("meta[property='og:image']").attr("content")
        ?? document("meta[name='twitter:image']").attr("content"),
      pageUrl,
    );
    const alt = normalizedText(
      document("meta[property='og:image:alt']").attr("content")
        ?? document("meta[name='twitter:image:alt']").attr("content"),
    );
    const width = dimension(document("meta[property='og:image:width']").attr("content"));
    const height = dimension(document("meta[property='og:image:height']").attr("content"));
    if (sourceUrl) {
      seen.add(sourceUrl);
      images.push({
        sourceUrl,
        role: "lead",
        ...(alt ? { alt, caption: alt } : {}),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
      });
    }
  }

  // Retain a narrow compatibility path for older AP gallery captures that did
  // not expose Page-lead or Open Graph media.
  if (!images.length) {
    const slides = document(".Carousel-slides").first().find(".Carousel-slide > .CarouselSlide");
    if (slides.length) {
      slides.each((order, element) => add(document(element), {
        role: order ? "content" : "lead",
        ...(order ? { afterBlock: 0 } : {}),
        carousel: { order, total: slides.length },
      }));
    }
  }

  const body = document(".RichTextStoryBody, [itemprop='articleBody']").first();
  if (body.length) {
    const bodyChildren = body.children().toArray();
    body.find("figure").each((_, element) => {
      const figure = document(element);
      if (figure.closest("aside,.PagePromo,.RelatedStories,[class*='related'],[class*='Related'],[class*='recommend']").length) return;
      const figureElement = figure.get(0);
      const owner = bodyChildren.find((child) => child === figureElement
        || document(child).find("figure").toArray().includes(figureElement!));
      let afterBlock = 0;
      for (const child of bodyChildren) {
        if (child === owner) break;
        if (document(child).is("p,h2,h3,h4,blockquote,ul,ol,pre")) afterBlock += 1;
      }
      add(figure, { role: "content", afterBlock });
    });
  }

  return images;
}
