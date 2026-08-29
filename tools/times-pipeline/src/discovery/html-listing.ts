import { load, type CheerioAPI } from "cheerio";
import { articleId, normalizeArticleUrl } from "../identity.js";
import { isFullDiscoveryBody, plainText, publisherDate, stringList } from "../text.js";
import type { PublisherDateMode } from "../text.js";
import type { Candidate, DiscoveryResult, SourceConfig } from "../types.js";
import { fetchHtml, mapLimit } from "./http.js";

type JsonObject = Record<string, unknown>;

export interface HtmlListingProfile {
  listingUrl: string;
  articlePathPrefixes: string[];
  maximumItems: number;
  linkSelector?: string;
  bodySelectors?: string[];
  publicationDateSelectors?: string[];
  publicationDateExtractor?: (document: CheerioAPI) => string | undefined;
  publicationDateMode?: PublisherDateMode;
  isUnsupportedMedia?: (html: string, sourceUrl: string) => boolean;
  version: string;
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function objects(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.flatMap(objects);
  const row = object(value);
  if (!row) return [];
  return [row, ...Object.values(row).flatMap(objects)];
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  const row = object(value);
  return row ? text(row.name) : undefined;
}

function values(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(values);
  const result = text(value);
  return result ? [result] : [];
}

function articleJson(html: string): JsonObject | undefined {
  const document = load(html);
  const rows: JsonObject[] = [];
  document('script[type="application/ld+json"]').each((_, script) => {
    try {
      rows.push(...objects(JSON.parse(document(script).text())));
    } catch {
      // JSON-LD is optional; source-owned selectors remain available below.
    }
  });
  const articleTypes = new Set(["article", "newsarticle", "reportagenewsarticle", "analysisnewsarticle"]);
  return rows.find((row) => values(row["@type"]).some((type) => articleTypes.has(type.toLowerCase())));
}

function articleLinks(profile: HtmlListingProfile, html: string): string[] {
  const page = new URL(profile.listingUrl);
  const document = load(html);
  const links: string[] = [];
  const seen = new Set<string>();
  document(profile.linkSelector ?? "a[href]").each((_, element) => {
    const href = document(element).attr("href");
    if (!href || links.length >= profile.maximumItems) return;
    try {
      const url = new URL(href, page);
      if (url.hostname !== page.hostname
        || !profile.articlePathPrefixes.some((prefix) => url.pathname.startsWith(prefix))) return;
      if (page.protocol === "http:") url.protocol = "http:";
      url.hash = "";
      const normalized = url.toString();
      if (seen.has(normalized)) return;
      seen.add(normalized);
      links.push(normalized);
    } catch {
      // Ignore malformed publisher links without discarding the listing.
    }
  });
  return links;
}

function bodyHtml(value: string): string {
  const escaped = value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const paragraphs = escaped.split(/\r?\n(?:\s*\r?\n)*/u).map((part) => part.trim()).filter(Boolean);
  return paragraphs.map((part) => `<p>${part}</p>`).join("");
}

function firstSelectedText(document: ReturnType<typeof load>, selectors: string[]): string | undefined {
  return selectors.flatMap((selector) => document(selector).toArray())
    .map((element) => plainText(document(element).text()))
    .find(Boolean);
}

function selectedBody(document: ReturnType<typeof load>, selectors: string[]): string | undefined {
  const selector = [...selectors, "[itemprop='articleBody']", "article"].join(", ");
  const container = document(selector).first();
  if (!container.length) return undefined;
  container.find("script, style, nav, footer, header, aside, form, noscript, .adInContent").remove();
  return container.html()?.trim() || undefined;
}

function candidateFromArticle(
  source: SourceConfig,
  profile: HtmlListingProfile,
  sourceUrl: string,
  html: string,
): Candidate | undefined {
  const document = load(html);
  const json = articleJson(html);
  const heading = document("h1").toArray()
    .map((element) => plainText(document(element).text()))
    .toSorted((left, right) => right.length - left.length)[0];
  const title = [
    text(json?.headline),
    document('meta[property="og:title"]').attr("content"),
    heading,
    document("title").text(),
  ].map(plainText).find(Boolean)?.trim() ?? "";
  const selectorDate = firstSelectedText(document, profile.publicationDateSelectors ?? []);
  const extractedDate = profile.publicationDateExtractor?.(document);
  const dateValues = profile.publicationDateMode === "wall-clock"
    ? [extractedDate, selectorDate, json?.datePublished, document('meta[property="article:published_time"]').attr("content"), document('meta[name="publishdate"], meta[name="date"]').first().attr("content"), document("time[datetime]").first().attr("datetime")]
    : [extractedDate, json?.datePublished, document('meta[property="article:published_time"]').attr("content"), selectorDate, document('meta[name="publishdate"], meta[name="date"]').first().attr("content"), document("time[datetime]").first().attr("datetime")];
  const publishedAt = dateValues
    .map((value) => publisherDate(text(value), source.publicationTimeZone, profile.publicationDateMode))
    .find((value): value is string => Boolean(value));
  if (!title || !publishedAt) return undefined;
  const declaredUrl = text(json?.url) ?? document('link[rel="canonical"]').attr("href") ?? sourceUrl;
  const canonicalUrl = normalizeArticleUrl(new URL(declaredUrl, sourceUrl).toString());
  const rawBody = text(json?.articleBody);
  const renderedBody = rawBody ? bodyHtml(rawBody) : selectedBody(document, profile.bodySelectors ?? []);
  const discoveryBody = source.content.priority.includes("discovery-body") && renderedBody && isFullDiscoveryBody(
    renderedBody,
    source.content.minimumFullCharacters,
    source.content.minimumFullParagraphs,
  ) ? renderedBody : undefined;
  const summary = plainText(
    text(json?.description)
      ?? document('meta[property="og:description"], meta[name="description"]').first().attr("content"),
  ).slice(0, 1_000) || undefined;
  return {
    articleId: articleId(source.id, canonicalUrl),
    sourceId: source.id,
    sourceName: source.name,
    language: source.language,
    sourceUrl,
    canonicalUrl,
    title: title.slice(0, 1_000),
    ...(summary ? { summary } : {}),
    ...(discoveryBody ? { discoveryBody } : {}),
    contentStatus: discoveryBody ? "full" : summary ? "summary" : "metadata",
    publishedAt,
    authors: [...new Set([...values(json?.author), ...stringList(document('meta[name="author"]').attr("content"))])],
    publisherCategories: [...new Set([
      ...values(json?.articleSection),
      ...stringList(json?.keywords),
      ...stringList(document('meta[name="keywords"]').attr("content")),
    ])],
  };
}

export function sectionUrl(source: SourceConfig, sectionId: string): string {
  const section = source.sections?.find((value) => value.id === sectionId);
  if (!section) throw new Error(`${source.id}: unknown discovery section: ${sectionId}`);
  return section.url;
}

export async function discoverHtmlListing(
  source: SourceConfig,
  fetchedAt: string,
  profile: HtmlListingProfile,
): Promise<DiscoveryResult> {
  const listingHtml = await fetchHtml(source.id, profile.listingUrl);
  const links = articleLinks(profile, listingHtml);
  let failedPages = 0;
  let unsupportedMediaPages = 0;
  const candidates = await mapLimit<Candidate>(links, 8, async (sourceUrl) => {
    try {
      const html = await fetchHtml(source.id, sourceUrl);
      if (profile.isUnsupportedMedia?.(html, sourceUrl)) {
        unsupportedMediaPages += 1;
        return undefined;
      }
      return candidateFromArticle(source, profile, sourceUrl, html);
    } catch {
      failedPages += 1;
      return undefined;
    }
  });
  return {
    source,
    transport: "source-adapter",
    fetchedAt,
    version: profile.version,
    upstream: {
      pageUrl: profile.listingUrl,
      articleUrls: links,
      parsedArticleCount: candidates.length,
      failedArticleCount: failedPages,
      unsupportedMediaCount: unsupportedMediaPages,
    },
    candidates,
  };
}
