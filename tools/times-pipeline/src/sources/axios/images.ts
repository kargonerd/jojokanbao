import { load, type CheerioAPI } from "cheerio";
import type { PageImageCandidate } from "../../capture/page-images.js";
import { semanticHtmlBlocks } from "../../content/paragraphs.js";

const EXCLUDED_SELECTOR = "aside,nav,footer,[class*='author'],[class*='byline'],[class*='share'],[class*='preferred'],[class*='promo'],[class*='recommend'],[class*='related'],[class*='advert']";
const BODY_SELECTOR = ".gtm-story-text, [data-testid='story-body']";
const PUBLISHER_PROMO = /^(?:Add Axios as your preferred source|see more of our stories on Google\.?$)/iu;

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
  const candidates = [image.attr("data-srcset"), image.attr("srcset"), ...image.closest("picture").find("source").toArray().flatMap((source) => {
    const node = document(source);
    return [node.attr("data-srcset"), node.attr("srcset")];
  })].map((value) => bestSrcset(value, pageUrl)).filter((value): value is { url: string; score: number } => Boolean(value));
  return candidates.toSorted((left, right) => right.score - left.score)[0]?.url
    ?? absoluteUrl(image.attr("data-src") ?? image.attr("data-original") ?? image.attr("src"), pageUrl);
}

function dimension(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function priorBodyBlocks(document: CheerioAPI, body: ReturnType<CheerioAPI>, image: ReturnType<CheerioAPI>, pageUrl: string): number {
  const values: string[] = [];
  body.find("p,h2,h3,h4,blockquote,ul,ol,pre,img").each((_, element) => {
    if (element === image[0]) return false;
    const node = document(element);
    if (node.is("img") || node.closest(`${EXCLUDED_SELECTOR},figure,figcaption`).length) return;
    const text = normalizedText(node.text());
    if (!text || PUBLISHER_PROMO.test(text) || (/^(?:Illustration|Photo):/iu.test(text) && text.length < 160)) return;
    if (node.parents("p,h2,h3,h4,blockquote,ul,ol,pre").filter((_, parent) => document(parent).closest(BODY_SELECTOR).length > 0).length) return;
    values.push(document.html(element));
  });
  const extracted = semanticHtmlBlocks(values, { minimumCharacters: 0, minimumParagraphs: 0 }, pageUrl);
  return extracted ? load(extracted, undefined, false).root().children("blockquote,h2,h3,h4,ol,p,pre,ul").length : 0;
}

export function extractAxiosImages(html: string, pageUrl: string): PageImageCandidate[] {
  const document = load(html);
  const article = document("main article").first().length ? document("main article").first() : document("article").first();
  const body = document(BODY_SELECTOR).first();
  if (!article.length || !body.length) return [];
  const bodyDescendants = new Set(body.find("*").toArray());
  const results: PageImageCandidate[] = [];
  const seen = new Set<string>();
  let leadAssigned = false;
  article.find("figure,img").filter("img,figure:has(img)").each((_, element) => {
    const owner = document(element);
    const image = owner.is("img") ? owner : owner.find("img").first();
    if (!image.length || image.closest(EXCLUDED_SELECTOR).length || image.closest("figure").length && !owner.is("figure")) return;
    const insideBody = bodyDescendants.has(image[0]!);
    if (!insideBody && leadAssigned) return;
    const sourceUrl = imageUrl(document, image, pageUrl);
    if (!sourceUrl || seen.has(sourceUrl)) return;
    const width = dimension(image.attr("width"));
    const height = dimension(image.attr("height"));
    const alt = normalizedText(image.attr("alt") ?? "") || undefined;
    if ((width !== undefined && width <= 100) || (height !== undefined && height <= 100) || /(?:logo|avatar|icon|badge|profile)/iu.test(`${sourceUrl} ${alt ?? ""}`)) return;
    const figure = image.closest("figure");
    const caption = normalizedText(figure.find("figcaption").first().text()) || undefined;
    const afterBlock = insideBody ? priorBodyBlocks(document, body, image, pageUrl) : 0;
    const lead = !insideBody || results.length === 0 && afterBlock === 0;
    seen.add(sourceUrl);
    if (lead) leadAssigned = true;
    results.push({
      sourceUrl,
      role: lead ? "lead" : "content",
      ...(lead ? {} : { afterBlock }),
      ...(alt ? { alt } : {}),
      ...(caption ? { caption } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    });
  });
  return results;
}
