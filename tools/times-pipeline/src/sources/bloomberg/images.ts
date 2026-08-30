import { load } from "cheerio";
import type { PageImageCandidate } from "../../capture/page-images.js";
import { semanticHtmlBlocks } from "../../content/paragraphs.js";
import { bloombergBlockHtml, bloombergObject, bloombergPageProps, type BloombergObject } from "./process.js";

function normalizedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = load(value, undefined, false).text().replaceAll(/\s+/gu, " ").trim();
  return text || undefined;
}

function absoluteUrl(value: unknown, pageUrl: string): string | undefined {
  if (typeof value !== "string" || value.startsWith("data:") || value.startsWith("blob:")) return undefined;
  try {
    const url = new URL(value, pageUrl);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function dimension(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function combinedCaption(...values: unknown[]): string | undefined {
  const parts = values.map(normalizedText).filter((value): value is string => Boolean(value));
  return [...new Set(parts)].join(" ") || undefined;
}

function emittedBlockCount(values: string[], pageUrl: string): number {
  const body = semanticHtmlBlocks(values, { minimumCharacters: 0, minimumParagraphs: 0 }, pageUrl);
  return body ? load(body, undefined, false).root().children("blockquote,h2,h3,h4,ol,p,pre,ul").length : 0;
}

function mediaCandidate(block: BloombergObject, pageUrl: string, afterBlock: number): PageImageCandidate | undefined {
  if (block.type !== "media") return undefined;
  const data = bloombergObject(block.data);
  const attachment = bloombergObject(data?.attachment);
  if (block.subType === "photo") {
    const photo = bloombergObject(data?.photo);
    const sourceUrl = absoluteUrl(photo?.src ?? attachment?.url, pageUrl);
    if (!sourceUrl) return undefined;
    const caption = combinedCaption(photo?.caption, photo?.credit);
    const credit = normalizedText(photo?.credit);
    const alt = normalizedText(photo?.alt ?? attachment?.alt ?? attachment?.title);
    const width = dimension(attachment?.width ?? attachment?.origWidth);
    const height = dimension(attachment?.height ?? attachment?.origHeight);
    return {
      sourceUrl,
      role: "content",
      afterBlock,
      ...(alt ? { alt } : {}),
      ...(caption ? { caption } : {}),
      ...(credit ? { credit } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    };
  }
  if (block.subType === "chart") {
    const chart = bloombergObject(data?.chart);
    const responsive = bloombergObject(attachment?.responsiveImages);
    const light = bloombergObject(responsive?.light);
    const fallback = absoluteUrl(light?.url ?? chart?.fallback, pageUrl);
    if (!fallback) return undefined;
    const caption = combinedCaption(attachment?.title, attachment?.subtitle);
    const credit = normalizedText(attachment?.source);
    const fullCaption = combinedCaption(caption, credit);
    const width = dimension(light?.width);
    const height = dimension(light?.height);
    return {
      sourceUrl: fallback,
      role: "content",
      afterBlock,
      ...(caption ? { alt: caption } : {}),
      ...(fullCaption ? { caption: fullCaption } : {}),
      ...(credit ? { credit } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    };
  }
  return undefined;
}

export function extractBloombergImages(html: string, pageUrl: string): PageImageCandidate[] {
  const pageProps = bloombergPageProps(html);
  if (!pageProps) return [];
  const story = bloombergObject(pageProps.story);
  const results: PageImageCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: PageImageCandidate | undefined): void => {
    if (!candidate || seen.has(candidate.sourceUrl)) return;
    seen.add(candidate.sourceUrl);
    results.push(candidate);
  };

  const lede = bloombergObject(story?.lede);
  const ledeUrl = absoluteUrl(lede?.url, pageUrl);
  if (ledeUrl) {
    const caption = combinedCaption(lede?.caption, lede?.credit);
    const credit = normalizedText(lede?.credit);
    const alt = normalizedText(lede?.alt ?? lede?.title);
    const width = dimension(lede?.width ?? lede?.origWidth);
    const height = dimension(lede?.height ?? lede?.origHeight);
    add({
      sourceUrl: ledeUrl,
      role: "lead",
      ...(alt ? { alt } : {}),
      ...(caption ? { caption } : {}),
      ...(credit ? { credit } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    });
  }

  const bodyBlocks: string[] = [];
  const addContent = (value: unknown): void => {
    const content = bloombergObject(value);
    for (const entry of Array.isArray(content?.content) ? content.content : []) {
      const block = bloombergObject(entry);
      if (!block) continue;
      const media = mediaCandidate(block, pageUrl, emittedBlockCount(bodyBlocks, pageUrl));
      if (media) add(media);
      else {
        const html = bloombergBlockHtml(block);
        if (html) bodyBlocks.push(html);
      }
    }
  };
  addContent(story?.body);
  const liveblog = bloombergObject(pageProps.liveblog);
  for (const value of Array.isArray(liveblog?.posts) ? liveblog.posts : []) {
    addContent(bloombergObject(value)?.body);
  }
  return results;
}
