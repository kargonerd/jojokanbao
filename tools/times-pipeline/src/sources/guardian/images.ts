import { load, type CheerioAPI } from "cheerio";
import type { PageImageCandidate } from "../../capture/page-images.js";
import { semanticHtmlBlocks } from "../../content/paragraphs.js";
import { guardianBodyStructure, type GuardianDocumentElement } from "./process.js";

const EXCLUDED_SELECTOR = [
  "aside",
  "nav",
  "footer",
  "[data-gu-name='tags']",
  "[data-gu-name*='related']",
  "[data-gu-name*='recommend']",
  "[data-print-layout='hide']",
  "[class*='ad-slot']",
  "[class*='related']",
  "[class*='recommend']",
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

function urlScore(value: string, descriptor: string | undefined): number {
  const parsed = descriptor?.match(/^(\d+(?:\.\d+)?)(w|x)$/u);
  if (parsed) return Number(parsed[1]) * (parsed[2] === "x" ? 10_000 : 1);
  try {
    const url = new URL(value);
    return (Number(url.searchParams.get("width")) || 0) * (Number(url.searchParams.get("dpr")) || 1);
  } catch {
    return 0;
  }
}

function imageUrl(document: CheerioAPI, image: ReturnType<CheerioAPI>, pageUrl: string): string | undefined {
  const values: Array<{ url: string; score: number }> = [];
  const addSrcset = (srcset: string | undefined): void => {
    for (const entry of srcset?.split(",") ?? []) {
      const [rawUrl, descriptor] = entry.trim().split(/\s+/u);
      const url = absoluteUrl(rawUrl, pageUrl);
      if (url) values.push({ url, score: urlScore(url, descriptor) });
    }
  };
  addSrcset(image.attr("srcset"));
  image.closest("picture").find("source").each((_, element) => addSrcset(document(element).attr("srcset")));
  const src = absoluteUrl(image.attr("data-src") ?? image.attr("src"), pageUrl);
  if (src) values.push({ url: src, score: urlScore(src, undefined) });
  return values.toSorted((left, right) => right.score - left.score)[0]?.url;
}

const ATTACHABLE_BLOCK_SELECTOR = "blockquote,h2,h3,h4,ol,p,pre,ul";

function emittedBlockCount(document: CheerioAPI, elements: GuardianDocumentElement[], pageUrl: string): number {
  const body = semanticHtmlBlocks(elements.map((element) => document.html(element)), {
    minimumCharacters: 0,
    minimumParagraphs: 0,
  }, pageUrl);
  return body ? load(body, undefined, false).root().children(ATTACHABLE_BLOCK_SELECTOR).length : 0;
}

function priorBodyBlocks(
  document: CheerioAPI,
  body: ReturnType<CheerioAPI>,
  blocks: GuardianDocumentElement[],
  image: ReturnType<CheerioAPI>,
  pageUrl: string,
): number {
  const order = new Map<GuardianDocumentElement, number>();
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

function dimension(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function extractGuardianImages(html: string, pageUrl: string): PageImageCandidate[] {
  const document = load(html);
  const article = document("main article").first().length ? document("main article").first() : document("article").first();
  const structure = guardianBodyStructure(document);
  if (!article.length || !structure) return [];
  const { body, blockElements } = structure;
  const bodyDescendants = new Set<GuardianDocumentElement>(body.find("*").toArray());

  const results: PageImageCandidate[] = [];
  const seen = new Set<string>();
  let leadAssigned = false;

  article.find("figure").each((_, element) => {
    const figure = document(element);
    if (figure.closest(EXCLUDED_SELECTOR).length) return;
    const image = figure.find("img").first();
    if (!image.length) return;
    const sourceUrl = imageUrl(document, image, pageUrl);
    if (!sourceUrl || seen.has(sourceUrl)) return;
    const insideBody = bodyDescendants.has(image[0]!);
    if (!insideBody && leadAssigned) return;
    const alt = normalizedText(image.attr("alt") ?? "") || undefined;
    if (/(?:logo|avatar|icon|badge|profile|tracking|pixel)/iu.test(`${sourceUrl} ${alt ?? ""}`)) return;
    const captionNode = figure.find("figcaption").first().clone();
    captionNode.find("svg,button").remove();
    const caption = normalizedText(captionNode.text()) || undefined;
    const credit = caption?.match(/(?:Photograph|Illustration|Graphic):\s*.+$/iu)?.[0];
    const width = dimension(image.attr("width"));
    const height = dimension(image.attr("height"));
    const afterBlock = insideBody ? priorBodyBlocks(document, body, blockElements, image, pageUrl) : undefined;
    seen.add(sourceUrl);
    if (!insideBody) leadAssigned = true;
    results.push({
      sourceUrl,
      role: insideBody ? "content" : "lead",
      ...(insideBody ? { afterBlock: afterBlock ?? 0 } : {}),
      ...(alt ? { alt } : {}),
      ...(caption ? { caption } : {}),
      ...(credit ? { credit } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    });
  });
  return results;
}
