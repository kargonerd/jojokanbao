import { load } from "cheerio";
import type { PageImageCandidate } from "../../capture/page-images.js";
import { semanticHtmlBlocks } from "../../content/paragraphs.js";
import { alJazeeraSemanticBlockHtml, alJazeeraStoryContainers } from "./process.js";

const EXCLUDED = ".more-on,.container--ads,.in-article-ads,[class*='advert'],[data-component*='recommend']";
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

function bestSrcsetUrl(value: string | undefined, pageUrl: string): string | undefined {
  const candidates = value?.split(",").map((entry, index) => {
    const [rawUrl, descriptor] = entry.trim().split(/\s+/u);
    const url = absoluteUrl(rawUrl, pageUrl);
    if (!url) return undefined;
    const width = descriptor?.match(/^(\d+)w$/u)?.[1];
    return { url, score: width ? Number(width) : index };
  }).filter((value): value is { url: string; score: number } => Boolean(value));
  return candidates?.toSorted((left, right) => right.score - left.score)[0]?.url;
}

function imageUrl(
  document: ReturnType<typeof load>,
  image: ReturnType<ReturnType<typeof load>>,
  pageUrl: string,
): string | undefined {
  const picture = image.closest("picture");
  const srcsets = [
    image.attr("data-srcset"),
    image.attr("srcset"),
    ...picture.find("source").toArray().flatMap((source) => {
      const node = document(source);
      return [node.attr("data-srcset"), node.attr("srcset")];
    }),
  ];
  return srcsets.map((value) => bestSrcsetUrl(value, pageUrl)).find(Boolean)
    ?? absoluteUrl(image.attr("data-src") ?? image.attr("src"), pageUrl);
}

function dimension(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function precedingBlockCount(
  document: ReturnType<typeof load>,
  owner: ReturnType<ReturnType<typeof load>>,
  pageUrl: string,
  containers: ReturnType<typeof alJazeeraStoryContainers>,
): number {
  const ownerContainer = owner.closest(".wysiwyg").get(0);
  const precedingBlocks: string[] = [];
  for (const container of containers) {
    if (container.get(0) === ownerContainer) {
      precedingBlocks.push(...alJazeeraSemanticBlockHtml(document, container, owner.get(0)));
      break;
    }
    precedingBlocks.push(...alJazeeraSemanticBlockHtml(document, container));
  }
  const sanitized = semanticHtmlBlocks(
    precedingBlocks,
    { minimumCharacters: 0, minimumParagraphs: 0 },
    pageUrl,
  );
  if (!sanitized) return 0;
  const fragment = load(sanitized, undefined, false);
  return fragment.root().children().toArray()
    .filter((element) => ATTACHABLE_BLOCKS.has(element.tagName.toLowerCase())).length;
}

export function extractAlJazeeraImages(html: string, pageUrl: string): PageImageCandidate[] {
  const document = load(html);
  const containers = alJazeeraStoryContainers(document);
  const owners = [
    ...document("main figure.article-featured-image, article figure.article-featured-image").toArray(),
    ...containers.flatMap((container) => container.find("figure,img").toArray()),
  ].filter((element, index, values) => values.indexOf(element) === index)
    .filter((element) => !document(element).is("img") || !document(element).closest("figure").length);
  const images: PageImageCandidate[] = [];
  const seen = new Set<string>();
  for (const element of owners) {
    const owner = document(element);
    if (owner.closest(EXCLUDED).length) continue;
    const figure = owner.is("figure") ? owner : owner.closest("figure");
    const image = owner.is("img") ? owner : owner.find("img").first();
    const sourceUrl = imageUrl(document, image, pageUrl);
    if (!sourceUrl || seen.has(sourceUrl)) continue;
    seen.add(sourceUrl);
    const lead = figure.hasClass("article-featured-image");
    const alt = normalizedText(image.attr("alt") ?? "") || undefined;
    const caption = normalizedText(figure.find("figcaption").first().text()) || undefined;
    const width = dimension(image.attr("width"));
    const height = dimension(image.attr("height"));
    images.push({
      sourceUrl,
      role: lead ? "lead" : "content",
      ...(!lead ? { afterBlock: precedingBlockCount(document, owner, pageUrl, containers) } : {}),
      ...(alt ? { alt } : {}),
      ...(caption ? { caption } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    });
  }
  return images;
}
