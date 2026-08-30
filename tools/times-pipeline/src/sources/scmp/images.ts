import { load } from "cheerio";
import type { PageImageCandidate } from "../../capture/page-images.js";
import { semanticHtmlBlocks } from "../../content/paragraphs.js";
import { scmpArticleBodyEntries, scmpArticleData, type ScmpJsonObject } from "./process.js";

const ATTACHABLE_BLOCKS = new Set(["blockquote", "h2", "h3", "h4", "ol", "p", "pre", "ul"]);

function object(value: unknown): ScmpJsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ScmpJsonObject : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
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

function imageCandidate(
  value: unknown,
  pageUrl: string,
  role: "lead" | "content",
  afterBlock?: number,
): PageImageCandidate | undefined {
  const image = object(value);
  const attribs = object(image?.attribs);
  const sourceUrl = absoluteUrl(string(image?.url) ?? string(attribs?.src), pageUrl);
  if (!sourceUrl) return undefined;
  const caption = string(image?.title) ?? string(attribs?.title) ?? string(attribs?.alt);
  const alt = string(attribs?.alt) ?? caption;
  const width = number(image?.width) ?? (Number(string(attribs?.width)) || undefined);
  const height = number(image?.height) ?? (Number(string(attribs?.height)) || undefined);
  return {
    sourceUrl,
    role,
    ...(afterBlock !== undefined ? { afterBlock } : {}),
    ...(alt ? { alt } : {}),
    ...(caption ? { caption } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
  };
}

function sanitizedBlockCount(blocks: string[], pageUrl: string): number {
  const sanitized = semanticHtmlBlocks(
    blocks,
    { minimumCharacters: 0, minimumParagraphs: 0 },
    pageUrl,
  );
  if (!sanitized) return 0;
  const document = load(sanitized, undefined, false);
  return document.root().children().toArray()
    .filter((element) => ATTACHABLE_BLOCKS.has(element.tagName.toLowerCase())).length;
}

export function extractScmpImages(html: string, pageUrl: string): PageImageCandidate[] {
  const article = scmpArticleData(html);
  if (!article) return [];
  const images: PageImageCandidate[] = [];
  const seen = new Set<string>();
  const publisherImages = Array.isArray(article.images) ? article.images : [];
  const leading = publisherImages.find((value) => object(value)?.type === "leading") ?? publisherImages[0];
  const slides = Array.isArray(article.leadingSlides) ? article.leadingSlides : [];
  const gallery = [leading, ...slides].filter((value) => Boolean(object(value)));
  const galleryCandidates = gallery.map((value, index) => imageCandidate(
    value,
    pageUrl,
    index === 0 ? "lead" : "content",
    index === 0 ? undefined : 0,
  )).filter((value): value is PageImageCandidate => Boolean(value))
    .filter((value) => !seen.has(value.sourceUrl) && Boolean(seen.add(value.sourceUrl)));
  for (const [order, candidate] of galleryCandidates.entries()) {
    images.push({
      ...candidate,
      ...(galleryCandidates.length > 1 ? {
        presentation: {
          type: "carousel" as const,
          id: "scmp-leading-gallery",
          order,
          total: galleryCandidates.length,
        },
      } : {}),
    });
  }

  const bodyBlocks: string[] = [];
  for (const entry of scmpArticleBodyEntries(article)) {
    if (entry.kind === "block") {
      bodyBlocks.push(entry.html);
      continue;
    }
    const candidate = imageCandidate(entry.image, pageUrl, "content", sanitizedBlockCount(bodyBlocks, pageUrl));
    if (!candidate || seen.has(candidate.sourceUrl)) continue;
    seen.add(candidate.sourceUrl);
    images.push(candidate);
  }
  return images;
}
