import { load } from "cheerio";
import type { PageImageCandidate } from "../../capture/page-images.js";
import { semanticHtmlBlocks } from "../../content/paragraphs.js";
import { focusTaiwanSemanticBlockHtml } from "./process.js";

const ATTACHABLE_BLOCKS = new Set(["blockquote", "h2", "h3", "h4", "ol", "p", "pre", "ul"]);

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

function bestSrcsetUrl(value: string | undefined, pageUrl: string): { url: string; score: number } | undefined {
  const candidates = value?.split(",").map((entry, index) => {
    const [rawUrl, descriptor] = entry.trim().split(/\s+/u);
    const url = absoluteUrl(rawUrl, pageUrl);
    if (!url) return undefined;
    const described = descriptor?.match(/^(\d+(?:\.\d+)?)(w|x)$/u);
    const pathWidth = url.match(/\/(\d{3,4})\//u)?.[1];
    const score = described
      ? Number(described[1]) * (described[2] === "x" ? 10_000 : 1)
      : pathWidth ? Number(pathWidth) : index;
    return { url, score };
  }).filter((value): value is { url: string; score: number } => Boolean(value));
  return candidates?.toSorted((left, right) => right.score - left.score)[0];
}

function imageUrl(
  document: ReturnType<typeof load>,
  image: ReturnType<ReturnType<typeof load>>,
  pageUrl: string,
): string | undefined {
  const source = image.closest("picture").find("source").toArray().flatMap((element) => {
    const node = document(element);
    return [node.attr("data-srcset"), node.attr("srcset")];
  }).map((value) => bestSrcsetUrl(value, pageUrl))
    .filter((value): value is { url: string; score: number } => Boolean(value))
    .toSorted((left, right) => right.score - left.score)[0]?.url;
  return source ?? absoluteUrl(image.attr("data-src") ?? image.attr("src"), pageUrl);
}

function dimensions(figure: ReturnType<ReturnType<typeof load>>): { width?: number; height?: number } {
  const style = figure.find("picture").first().attr("style") ?? "";
  const match = style.match(/--aspect-ratio:\s*(\d+)\s*\/\s*(\d+)/u);
  if (!match) return {};
  return { width: Number(match[1]), height: Number(match[2]) };
}

function precedingBlockCount(
  document: ReturnType<typeof load>,
  media: ReturnType<ReturnType<typeof load>>,
  pageUrl: string,
): number {
  const article = media.closest(".paragraph");
  const sanitized = semanticHtmlBlocks(
    focusTaiwanSemanticBlockHtml(document, article, media.get(0)),
    { minimumCharacters: 0, minimumParagraphs: 0 },
    pageUrl,
  );
  if (!sanitized) return 0;
  const fragment = load(sanitized, undefined, false);
  return fragment.root().children().toArray()
    .filter((element) => ATTACHABLE_BLOCKS.has(element.tagName.toLowerCase())).length;
}

export function extractFocusTaiwanImages(html: string, pageUrl: string): PageImageCandidate[] {
  const document = load(html);
  const figures = [
    ...document(".PrimarySide > .FullPic figure").toArray(),
    ...document(".paragraph > .media figure").toArray(),
  ];
  const images: PageImageCandidate[] = [];
  const seen = new Set<string>();
  for (const element of figures) {
    const figure = document(element);
    const image = figure.find("img").first();
    const sourceUrl = imageUrl(document, image, pageUrl);
    if (!sourceUrl || seen.has(sourceUrl)) continue;
    seen.add(sourceUrl);
    const lead = figure.closest(".FullPic").length > 0;
    const alt = normalizedText(image.attr("alt") ?? "") || undefined;
    const caption = normalizedText(figure.find("figcaption").first().text()) || undefined;
    const { width, height } = dimensions(figure);
    images.push({
      sourceUrl,
      role: lead ? "lead" : "content",
      ...(!lead ? { afterBlock: precedingBlockCount(document, figure.closest(".media"), pageUrl) } : {}),
      ...(alt ? { alt } : {}),
      ...(caption ? { caption } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    });
  }
  return images;
}
