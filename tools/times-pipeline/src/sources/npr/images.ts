import { load, type CheerioAPI } from "cheerio";
import type { PageImageCandidate } from "../../capture/page-images.js";
import { semanticHtmlBlocks } from "../../content/paragraphs.js";
import { nprBodyStructure, type NprDocumentElement } from "./process.js";

const ATTACHABLE_BLOCK_SELECTOR = "blockquote,h2,h3,h4,ol,p,pre,ul";
const EXCLUDED_IMAGE_OWNER = ".bucketwrap.internallink,aside,[class*='recommend'],[class*='related'],[class*='ad-wrap'],[class*='sponsor']";

function normalizedText(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
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

function bestSrcset(value: string | undefined, pageUrl: string): { url: string; score: number } | undefined {
  return value?.split(",").map((entry, index) => {
    const [raw, descriptor] = entry.trim().split(/\s+/u);
    const url = absoluteUrl(raw, pageUrl);
    if (!url) return undefined;
    const parsed = descriptor?.match(/^(\d+(?:\.\d+)?)(w|x)$/u);
    return { url, score: parsed ? Number(parsed[1]) * (parsed[2] === "x" ? 10_000 : 1) : index };
  }).filter((value): value is { url: string; score: number } => Boolean(value))
    .toSorted((left, right) => right.score - left.score)[0];
}

function imageUrl(document: CheerioAPI, image: ReturnType<CheerioAPI>, pageUrl: string): string | undefined {
  const picture = image.closest("picture");
  const candidates = [image.attr("data-srcset"), image.attr("srcset"), ...picture.find("source").toArray().flatMap((source) => {
    const node = document(source);
    return [node.attr("data-srcset"), node.attr("srcset")];
  })].map((value) => bestSrcset(value, pageUrl)).filter((value): value is { url: string; score: number } => Boolean(value));
  return candidates.toSorted((left, right) => right.score - left.score)[0]?.url
    ?? absoluteUrl(image.attr("data-original") ?? image.attr("data-src") ?? image.attr("src"), pageUrl);
}

function sourceDimension(wrapper: ReturnType<CheerioAPI>, name: "width" | "height"): number | undefined {
  const value = wrapper.attr("style")?.match(new RegExp(`--source-${name}:\\s*(\\d+)`, "u"))?.[1];
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function captionParts(owner: ReturnType<CheerioAPI>): { caption?: string; credit?: string } {
  const captionNode = owner.find(".caption[aria-label*='caption' i], .caption").first().clone();
  const credit = normalizedText(captionNode.find(".credit,[aria-label*='credit' i]").first().text()) || undefined;
  captionNode.find(".credit,[aria-label*='credit' i],button,[class*='hide'],[class*='toggle']").remove();
  const description = normalizedText(captionNode.text()) || undefined;
  const caption = [description, credit].filter(Boolean).join(" ") || undefined;
  return { ...(caption ? { caption } : {}), ...(credit ? { credit } : {}) };
}

function priorBlocks(
  document: CheerioAPI,
  body: ReturnType<CheerioAPI>,
  blocks: NprDocumentElement[],
  owner: ReturnType<CheerioAPI>,
  pageUrl: string,
): number {
  const order = new Map<NprDocumentElement, number>();
  body.find("*").each((index, element) => {
    order.set(element, index);
  });
  const imageOrder = order.get(owner[0]!);
  const preceding = blocks.filter((element) => {
    const blockOrder = order.get(element);
    return blockOrder !== undefined && imageOrder !== undefined && blockOrder < imageOrder;
  });
  const extracted = semanticHtmlBlocks(preceding.map((element) => document.html(element)), {
    minimumCharacters: 0,
    minimumParagraphs: 0,
  }, pageUrl);
  return extracted ? load(extracted, undefined, false).root().children(ATTACHABLE_BLOCK_SELECTOR).length : 0;
}

export function extractNprImages(html: string, pageUrl: string): PageImageCandidate[] {
  const document = load(html);
  const structure = nprBodyStructure(document);
  if (!structure) return [];
  const { body, blockElements } = structure;
  const results: PageImageCandidate[] = [];
  const seen = new Set<string>();
  body.find(".bucketwrap.image").each((_, element) => {
    const owner = document(element);
    if (owner.parents(EXCLUDED_IMAGE_OWNER).length) return;
    const image = owner.find("img").first();
    const sourceUrl = imageUrl(document, image, pageUrl);
    if (!sourceUrl || seen.has(sourceUrl)) return;
    const alt = normalizedText(image.attr("alt") ?? "") || undefined;
    const wrapper = owner.find(".imagewrap").first();
    const width = sourceDimension(wrapper, "width");
    const height = sourceDimension(wrapper, "height");
    const caption = captionParts(owner);
    const afterBlock = priorBlocks(document, body, blockElements, owner, pageUrl);
    const lead = results.length === 0 && afterBlock === 0;
    seen.add(sourceUrl);
    results.push({
      sourceUrl,
      role: lead ? "lead" : "content",
      ...(lead ? {} : { afterBlock }),
      ...(alt ? { alt } : {}),
      ...caption,
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    });
  });
  return results;
}
