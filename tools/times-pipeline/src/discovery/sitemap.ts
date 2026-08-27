import { XMLParser } from "fast-xml-parser";
import { BROWSER_USER_AGENT } from "../network/headers.js";
import { articleId, normalizeArticleUrl } from "../identity.js";
import { publisherDate, optionalString } from "../text.js";
import type { Candidate, DiscoveryResult, SourceConfig } from "../types.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
});

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function array(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function valueText(value: unknown): string | undefined {
  return optionalString(value) ?? optionalString(object(value)?.["#text"]);
}

function titleFromUrl(url: string): string {
  const segment = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? url;
  const title = decodeURIComponent(segment)
    .replace(/-\d{4}-\d{2}-\d{2}$/u, "")
    .replace(/--[a-z0-9]+$/iu, "")
    .replaceAll("-", " ")
    .replace(/\s+/gu, " ")
    .trim();
  return title ? title[0]?.toUpperCase() + title.slice(1) : url;
}

export function parseSitemap(source: SourceConfig, xml: string, fetchedAt: string): DiscoveryResult {
  if (source.discovery.kind !== "sitemap") throw new Error(`${source.id}: expected sitemap discovery`);
  const upstream = parser.parse(xml) as unknown;
  const root = object(upstream);
  const urlset = object(root?.urlset);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  for (const value of array(urlset?.url)) {
    const row = object(value);
    const sourceUrl = valueText(row?.loc);
    const publishedAt = publisherDate(valueText(row?.lastmod), source.publicationTimeZone);
    if (!sourceUrl || !publishedAt) continue;
    let canonicalUrl: string;
    try {
      canonicalUrl = normalizeArticleUrl(sourceUrl);
    } catch {
      continue;
    }
    const id = articleId(source.id, canonicalUrl);
    if (seen.has(id)) continue;
    seen.add(id);
    candidates.push({
      articleId: id,
      sourceId: source.id,
      sourceName: source.name,
      language: source.language,
      sourceUrl,
      canonicalUrl,
      title: titleFromUrl(canonicalUrl).slice(0, 1_000),
      contentStatus: "metadata",
      publishedAt,
      authors: [],
      publisherCategories: [],
    });
  }

  return { source, transport: "sitemap", fetchedAt, upstream: { xml, parsed: upstream }, candidates };
}

function sitemapPageUrls(xml: string): string[] {
  const root = object(parser.parse(xml));
  const sitemapindex = object(root?.sitemapindex);
  return array(sitemapindex?.sitemap)
    .map(object)
    .map((row) => valueText(row?.loc))
    .filter((value): value is string => Boolean(value));
}

async function fetchXml(sourceId: string, url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      accept: "application/xml, text/xml",
      "user-agent": BROWSER_USER_AGENT,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(70_000),
  });
  if (!response.ok) throw new Error(`${sourceId}: sitemap returned HTTP ${response.status}`);
  return response.text();
}

export async function discoverSitemap(source: SourceConfig, fetchedAt: string, cutoff: number): Promise<DiscoveryResult> {
  if (source.discovery.kind !== "sitemap") throw new Error(`${source.id}: expected sitemap discovery`);
  const indexXml = await fetchXml(source.id, source.discovery.url);
  const pageUrls = sitemapPageUrls(indexXml);
  if (pageUrls.length === 0) return parseSitemap(source, indexXml, fetchedAt);

  const candidates = new Map<string, Candidate>();
  const pages: Array<{ url: string; xml: string }> = [];
  for (const url of pageUrls.slice(0, source.discovery.maximumPages)) {
    const xml = await fetchXml(source.id, url);
    const page = parseSitemap(source, xml, fetchedAt);
    pages.push({ url, xml });
    for (const candidate of page.candidates) candidates.set(candidate.articleId, candidate);
    if (page.candidates.length > 0 && page.candidates.every((candidate) => new Date(candidate.publishedAt).valueOf() < cutoff)) {
      break;
    }
  }
  return {
    source,
    transport: "sitemap",
    fetchedAt,
    upstream: { indexUrl: source.discovery.url, indexXml, pages },
    candidates: [...candidates.values()],
  };
}
