import { XMLParser } from "fast-xml-parser";
import { BROWSER_USER_AGENT } from "../network/headers.js";
import { articleId, normalizeArticleUrl } from "../identity.js";
import { isFullDiscoveryBody, publisherDate, optionalString, plainText, stringList } from "../text.js";
import type { Candidate, DiscoveryResult, SourceConfig } from "../types.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: false,
});

function array(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function localValue(row: Record<string, unknown>, names: string[]): unknown {
  for (const [key, value] of Object.entries(row)) {
    if (names.includes(key.split(":").at(-1)?.toLowerCase() ?? "")) return value;
  }
  return undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  const row = object(value);
  return row ? optionalString(row["#text"]) ?? optionalString(row.__cdata) : undefined;
}

function entryLink(row: Record<string, unknown>, feedUrl: string): string | undefined {
  for (const value of array(localValue(row, ["link"]))) {
    const link = text(value) ?? optionalString(object(value)?.["@_href"]);
    if (!link) continue;
    try {
      return new URL(link, feedUrl).toString();
    } catch {
      // Try the next link.
    }
  }
  return undefined;
}

function feedEntries(parsed: unknown): Record<string, unknown>[] {
  const root = object(parsed);
  if (!root) return [];
  const rss = object(root.rss);
  const channel = object(rss?.channel);
  if (channel) return array(channel.item).map(object).filter((value): value is Record<string, unknown> => Boolean(value));
  const atom = object(root.feed);
  if (atom) return array(atom.entry).map(object).filter((value): value is Record<string, unknown> => Boolean(value));
  const rdf = object(root["rdf:RDF"] ?? root.RDF);
  return array(rdf?.item).map(object).filter((value): value is Record<string, unknown> => Boolean(value));
}

export function parseOfficialFeed(source: SourceConfig, xml: string, fetchedAt: string, feedUrl?: string): DiscoveryResult {
  if (source.discovery.kind !== "official-rss" && source.discovery.kind !== "official-rss-list") {
    throw new Error(`${source.id}: expected official-rss discovery`);
  }
  const resolvedFeedUrl = feedUrl ?? (source.discovery.kind === "official-rss" ? source.discovery.url : source.discovery.urls[0]);
  if (!resolvedFeedUrl) throw new Error(`${source.id}: official RSS URL is missing`);
  const upstream = parser.parse(xml) as unknown;
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const acceptsBody = source.content.priority.includes("discovery-body");
  for (const row of feedEntries(upstream)) {
    const title = plainText(text(localValue(row, ["title"])));
    const sourceUrl = entryLink(row, resolvedFeedUrl);
    const publishedAt = publisherDate(text(localValue(row, ["pubdate", "date", "published", "updated"])), source.publicationTimeZone);
    if (!title || !sourceUrl || !publishedAt) continue;
    let canonicalUrl: string;
    try {
      canonicalUrl = normalizeArticleUrl(sourceUrl);
    } catch {
      continue;
    }
    const id = articleId(source.id, canonicalUrl);
    if (seen.has(id)) continue;
    seen.add(id);
    const rawBody = text(localValue(row, ["encoded", "content", "description", "summary"]));
    const summary = plainText(rawBody).slice(0, 1_000) || undefined;
    const discoveryBody = acceptsBody && rawBody && isFullDiscoveryBody(
      rawBody,
      source.content.minimumFullCharacters,
      source.content.minimumFullParagraphs,
    ) ? rawBody.slice(0, 1_000_000) : undefined;
    const updatedAt = publisherDate(text(localValue(row, ["updated"])), source.publicationTimeZone);
    const upstreamId = text(localValue(row, ["guid", "id"]));
    candidates.push({
      articleId: id,
      sourceId: source.id,
      sourceName: source.name,
      language: source.language,
      sourceUrl,
      canonicalUrl,
      title: title.slice(0, 1_000),
      ...(summary ? { summary } : {}),
      ...(discoveryBody ? { discoveryBody } : {}),
      contentStatus: discoveryBody ? "full" : "summary",
      publishedAt,
      ...(updatedAt ? { updatedAt } : {}),
      authors: stringList(text(localValue(row, ["author", "creator"]))),
      publisherCategories: stringList(localValue(row, ["category"])),
      ...(upstreamId ? { upstreamId } : {}),
    });
  }
  return { source, transport: source.discovery.kind, fetchedAt, upstream: { feedUrl: resolvedFeedUrl, xml, parsed: upstream }, candidates };
}

export async function discoverOfficialRss(source: SourceConfig, fetchedAt: string): Promise<DiscoveryResult> {
  if (source.discovery.kind !== "official-rss" && source.discovery.kind !== "official-rss-list") {
    throw new Error(`${source.id}: expected official-rss discovery`);
  }
  const urls = source.discovery.kind === "official-rss" ? [source.discovery.url] : source.discovery.urls;
  const results = [];
  for (const url of urls) {
    const response = await fetch(url, {
      headers: {
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
        "user-agent": BROWSER_USER_AGENT,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(70_000),
    });
    if (!response.ok) throw new Error(`${source.id}: official RSS returned HTTP ${response.status} for ${url}`);
    results.push(parseOfficialFeed(source, await response.text(), fetchedAt, url));
  }
  const candidates = [...new Map(results.flatMap((result) => result.candidates).map((candidate) => [candidate.articleId, candidate])).values()];
  return {
    source,
    transport: source.discovery.kind,
    fetchedAt,
    upstream: results.map((result) => result.upstream),
    candidates,
  };
}
