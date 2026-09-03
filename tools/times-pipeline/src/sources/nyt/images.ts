import { load } from "cheerio";
import type { PageImageCandidate } from "../../capture/page-images.js";
import { nytVisibleSummaryBlockTexts } from "./process.js";

const BODY_SELECTOR = [
  "section[name='articleBody']",
  "[data-testid='article-body']",
  "[itemprop='articleBody']",
].join(",");

const TERMINAL_SELECTOR = [
  "[data-testid*='related']",
  "[data-testid*='recirculation']",
  "[class*='related-content']",
  "[class*='relatedContent']",
  "[class*='recommend']",
  "[class*='recirculation']",
].join(",");

const EXCLUDED_SELECTOR = [
  "nav",
  "footer",
  "aside",
  "[aria-label*='advertisement' i]",
  "[data-testid*='advert']",
  "[class*='advert']",
  "[class*='share']",
  TERMINAL_SELECTOR,
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

function bestSrcsetUrl(value: string | undefined, pageUrl: string): { url: string; score: number } | undefined {
  const candidates = value?.split(",").map((entry, index) => {
    const [rawUrl, descriptor] = entry.trim().split(/\s+/u);
    const url = absoluteUrl(rawUrl, pageUrl);
    if (!url) return undefined;
    const parsed = descriptor?.match(/^(\d+(?:\.\d+)?)(w|x)$/u);
    const score = parsed
      ? Number(parsed[1]) * (parsed[2] === "x" ? 10_000 : 1)
      : index;
    return { url, score };
  }).filter((value): value is { url: string; score: number } => Boolean(value));
  return candidates?.toSorted((left, right) => right.score - left.score)[0];
}

function imageUrl(
  document: ReturnType<typeof load>,
  image: ReturnType<ReturnType<typeof load>>,
  pageUrl: string,
): string | undefined {
  const picture = image.closest("picture");
  const srcsetValues = [
    image.attr("data-srcset"),
    image.attr("srcset"),
    ...picture.find("source").toArray().flatMap((source) => {
      const node = document(source);
      return [node.attr("data-srcset"), node.attr("srcset")];
    }),
  ];
  const srcset = srcsetValues
    .map((value) => bestSrcsetUrl(value, pageUrl))
    .filter((value): value is { url: string; score: number } => Boolean(value))
    .toSorted((left, right) => right.score - left.score)[0];
  return srcset?.url ?? absoluteUrl(
    image.attr("data-src") ?? image.attr("data-original") ?? image.attr("src"),
    pageUrl,
  );
}

function dimension(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function carouselPresentation(figure: { attr(name: string): string | undefined }): {
  type: "carousel";
  id: string;
  order: number;
  total: number;
} | undefined {
  const id = figure.attr("data-nyt-slideshow-id");
  const order = Number(figure.attr("data-nyt-slideshow-order"));
  const total = Number(figure.attr("data-nyt-slideshow-total"));
  if (!id || !/^[A-Za-z0-9_-]{1,100}$/u.test(id)) return undefined;
  if (!Number.isInteger(order) || order < 0 || !Number.isInteger(total) || total < 2 || order >= total) return undefined;
  return { type: "carousel", id, order, total };
}

function imageCredit(
  document: ReturnType<typeof load>,
  captionNode: ReturnType<ReturnType<typeof load>>,
): string | undefined {
  const explicit = normalizedText(captionNode.find([
    "[data-testid*='credit']",
    "[class*='credit']",
    "[aria-label*='credit' i]",
  ].join(",")).first().text());
  if (explicit) return explicit;

  const leafTexts = captionNode.find("span,p,div").filter((_, element) => {
    const node = document(element);
    return !node.find("span,p,div").length;
  }).toArray().map((element) => normalizedText(document(element).text())).filter(Boolean);
  return leafTexts.find((text) => /(?:\bcredit\b|\bphoto(?:graph)?\s+by\b|\billustration\s+by\b|\bfor The New York Times\b|\/The New York Times\b|©)/iu.test(text));
}

function terminalHeading(value: string): boolean {
  return /^(?:Related Content|More (?:to Read|From)|Recommended)(?:\s|$)/iu.test(value);
}

function semanticBlock(node: ReturnType<ReturnType<typeof load>>, text: string): boolean {
  if (!node.is("p,h2,h3,h4,blockquote,ul,ol,pre")) return false;
  if (node.closest("figure,figcaption").length) return false;
  return Boolean(text && (node.is("h2,h3,h4") || text.length >= 20));
}

export function extractNytImages(html: string, pageUrl: string): PageImageCandidate[] {
  const document = load(html);
  const article = document("main article").first().length
    ? document("main article").first()
    : document("article").first().length
      ? document("article").first()
      : document("main").first();
  if (!article.length) return [];

  const hasExplicitBody = article.find(BODY_SELECTOR).length > 0 || article.is(BODY_SELECTOR);
  const images: PageImageCandidate[] = [];
  const seenUrls = new Set<string>();
  const summaryBlockTexts = hasExplicitBody ? nytVisibleSummaryBlockTexts(document, pageUrl) : [];
  const seenBlocks = new Set(summaryBlockTexts);
  const seenFigures = new Set<unknown>();
  let bodyStarted = false;
  let blockCount = summaryBlockTexts.length;
  let leadAssigned = false;
  let reachedTerminalContent = false;

  article.find("*").each((_, element) => {
    if (reachedTerminalContent) return false;
    const node = document(element);
    const text = normalizedText(node.text());

    if (node.is("h2,h3") && terminalHeading(text)) {
      reachedTerminalContent = true;
      return false;
    }
    if (node.is(TERMINAL_SELECTOR)) return;
    if (node.closest(EXCLUDED_SELECTOR).length) return;

    const belongsToBody = !hasExplicitBody || node.closest(BODY_SELECTOR).length > 0 || node.is(BODY_SELECTOR);
    if (belongsToBody && semanticBlock(node, text) && !seenBlocks.has(text)) {
      bodyStarted = true;
      seenBlocks.add(text);
      blockCount += 1;
      return;
    }
    if (!node.is("img")) return;

    const image = node;
    const figure = image.closest("figure");
    const isPublisherEditorial = figure.is("[data-nyt-official-image='true'],[data-nyt-publisher-editorial='true']");
    const owner = figure.length ? figure.get(0) : image.get(0);
    if (seenFigures.has(owner)) return;
    seenFigures.add(owner);

    const sourceUrl = imageUrl(document, image, pageUrl);
    if (!sourceUrl || seenUrls.has(sourceUrl)) return;
    const alt = normalizedText(image.attr("alt") ?? "") || undefined;
    const width = dimension(image.attr("width"));
    const height = dimension(image.attr("height"));
    if ((width !== undefined && width <= 80) || (height !== undefined && height <= 80)) return;
    if (!isPublisherEditorial && /(?:logo|icon|avatar|tracking|pixel|sprite|placeholder)/iu.test(`${sourceUrl} ${alt ?? ""}`)) return;

    seenUrls.add(sourceUrl);
    const captionNode = figure.find("figcaption").first();
    const caption = captionNode.contents().toArray()
      .map((part) => normalizedText(document(part).text()))
      .filter(Boolean)
      .join(" ") || undefined;
    const credit = captionNode.length ? imageCredit(document, captionNode) : undefined;
    const presentation = carouselPresentation(figure);
    const occupiesLeadSlot = !leadAssigned && !bodyStarted;
    const isLead = !presentation && occupiesLeadSlot;
    // A header carousel remains a content-positioned media group so the
    // attachment layer does not split its first slide out as role=lead, but it
    // still occupies the publisher's lead slot. A later pre-paragraph image
    // must not jump ahead of the carousel during attachment.
    if (occupiesLeadSlot) leadAssigned = true;
    // NYT's visible standfirst precedes its lead media. The shared asset
    // attachment path always prepends role=lead assets, so keep this adapter
    // source-specific: when a standfirst exists, position the same publisher
    // image after those summary blocks as content. Without a standfirst it
    // remains a conventional lead asset.
    const positionAfterStandfirst = isLead && summaryBlockTexts.length > 0;
    images.push({
      sourceUrl,
      role: isLead && !positionAfterStandfirst ? "lead" : "content",
      ...(isLead && !positionAfterStandfirst ? {} : { afterBlock: blockCount }),
      ...(alt ? { alt } : {}),
      ...(caption ? { caption } : {}),
      ...(credit ? { credit } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(presentation ? { presentation } : {}),
    });
  });
  return images;
}
