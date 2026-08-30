import { load, type CheerioAPI } from "cheerio";
import type { PageImageCandidate } from "../../capture/page-images.js";
import { semanticHtmlBlocks } from "../../content/paragraphs.js";
import { ftBodyStructure, type FtDocumentElement } from "./process.js";

const EXCLUDED_SELECTOR = [
  "aside", "nav", "footer", "[class*='share']", "[class*='newsletter']", "[class*='promo']",
  "[class*='recommend']", "[class*='related']", "[class*='advert']", "[data-trackable*='share']",
  "[data-trackable*='newsletter']", "[data-trackable*='recommend']",
].join(",");

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
  const srcsets = [image.attr("data-srcset"), image.attr("srcset"), ...image.closest("picture").find("source").toArray().flatMap((source) => {
    const node = document(source);
    return [node.attr("data-srcset"), node.attr("srcset")];
  })].map((value) => bestSrcset(value, pageUrl)).filter((value): value is { url: string; score: number } => Boolean(value));
  return srcsets.toSorted((left, right) => right.score - left.score)[0]?.url
    ?? absoluteUrl(image.attr("data-src") ?? image.attr("data-original") ?? image.attr("src"), pageUrl);
}

function dimension(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const ATTACHABLE_BLOCK_SELECTOR = "blockquote,h2,h3,h4,ol,p,pre,ul";

function emittedBlockCount(document: CheerioAPI, elements: FtDocumentElement[], pageUrl: string): number {
  const body = semanticHtmlBlocks(elements.map((element) => document.html(element)), {
    minimumCharacters: 0,
    minimumParagraphs: 0,
  }, pageUrl);
  return body ? load(body, undefined, false).root().children(ATTACHABLE_BLOCK_SELECTOR).length : 0;
}

function priorBodyBlocks(
  document: CheerioAPI,
  body: ReturnType<CheerioAPI>,
  blocks: FtDocumentElement[],
  image: ReturnType<CheerioAPI>,
  pageUrl: string,
): number {
  const order = new Map<FtDocumentElement, number>();
  body.find("*").each((index, element) => {
    order.set(element, index);
  });
  const imageOrder = order.get(image[0]!);
  const preceding = blocks.filter((element) => {
    const blockOrder = order.get(element);
    return blockOrder === undefined || (imageOrder !== undefined && blockOrder < imageOrder);
  });
  return emittedBlockCount(document, preceding, pageUrl);
}

export function extractFtImages(html: string, pageUrl: string): PageImageCandidate[] {
  const document = load(html);
  const article = document("main article").first().length ? document("main article").first() : document("article").first();
  const structure = ftBodyStructure(document);
  if (!article.length || !structure) return [];
  const { body, blockElements, terminal } = structure;
  const bodyOrder = new Map<FtDocumentElement, number>();
  body.find("*").each((index, element) => {
    bodyOrder.set(element, index);
  });
  const terminalOrder = terminal ? bodyOrder.get(terminal) : undefined;
  const results: PageImageCandidate[] = [];
  const seen = new Set<string>();
  let leadAssigned = false;
  article.find("figure").each((_, element) => {
    const figure = document(element);
    if (figure.closest(EXCLUDED_SELECTOR).length) return;
    const image = figure.find("img").first();
    if (!image.length) return;
    const imageOrder = bodyOrder.get(image[0]!);
    const insideBody = imageOrder !== undefined;
    if (insideBody && terminalOrder !== undefined && imageOrder > terminalOrder) return;
    if (!insideBody && leadAssigned) return;
    const sourceUrl = imageUrl(document, image, pageUrl);
    if (!sourceUrl || seen.has(sourceUrl)) return;
    const width = dimension(image.attr("width"));
    const height = dimension(image.attr("height"));
    const alt = normalizedText(image.attr("alt") ?? "") || undefined;
    if ((width !== undefined && width <= 80) || (height !== undefined && height <= 80) || /(?:logo|avatar|icon|badge|profile)/iu.test(`${sourceUrl} ${alt ?? ""}`)) return;
    const caption = normalizedText(figure.find("figcaption").first().text()) || undefined;
    const credit = caption?.match(/(?:©|Photograph:|Illustration:).+$/iu)?.[0];
    const lead = !insideBody;
    seen.add(sourceUrl);
    if (lead) leadAssigned = true;
    results.push({
      sourceUrl,
      role: lead ? "lead" : "content",
      ...(lead ? {} : { afterBlock: priorBodyBlocks(document, body, blockElements, image, pageUrl) }),
      ...(alt ? { alt } : {}),
      ...(caption ? { caption } : {}),
      ...(credit ? { credit } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    });
  });
  return results;
}
