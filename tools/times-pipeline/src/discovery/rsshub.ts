import { articleId, normalizeArticleUrl } from "../identity.js";
import { isFullDiscoveryBody, isoDate, optionalString, plainText, stringList } from "../text.js";
import type { Candidate, DiscoveryResult, SourceConfig } from "../types.js";

export const RSSHUB_VERSION = "1.0.0-master.5151c32";

function absoluteUrl(value: string, base: unknown): string | undefined {
  try {
    return new URL(value, typeof base === "string" ? base : undefined).toString();
  } catch {
    return undefined;
  }
}

export function mapRssHubData(source: SourceConfig, upstream: unknown, fetchedAt: string): DiscoveryResult {
  if (!upstream || typeof upstream !== "object") throw new Error(`${source.id}: RSSHub returned a non-object response`);
  const data = upstream as Record<string, unknown>;
  if (data.error) {
    const error = data.error as Record<string, unknown> | string;
    const message = typeof error === "string" ? error : optionalString(error.message) ?? JSON.stringify(error);
    throw new Error(`${source.id}: RSSHub route failed: ${message}`);
  }
  const rows = Array.isArray(data.item) ? data.item : [];
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const acceptsBody = source.content.priority.includes("discovery-body");

  for (const value of rows) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    const title = plainText(item.title);
    const link = optionalString(item.link) ?? optionalString(item.url);
    const publishedAt = isoDate(item.pubDate) ?? isoDate(item.published) ?? isoDate(item.date);
    if (!title || !link || !publishedAt) continue;
    const resolved = absoluteUrl(link, data.link);
    if (!resolved) continue;
    let canonicalUrl: string;
    try {
      canonicalUrl = normalizeArticleUrl(resolved);
    } catch {
      continue;
    }
    const id = articleId(source.id, canonicalUrl);
    if (seen.has(id)) continue;
    seen.add(id);
    const description = optionalString(item.description) ?? optionalString(item.content) ?? optionalString(item.summary);
    const summaryText = plainText(description).slice(0, 1_000) || undefined;
    const discoveryBody = acceptsBody && description && isFullDiscoveryBody(
      description,
      source.content.minimumFullCharacters,
      source.content.minimumFullParagraphs,
    ) ? description.slice(0, 1_000_000) : undefined;
    const updatedAt = isoDate(item.updated);
    const upstreamId = optionalString(item.guid);
    candidates.push({
      articleId: id,
      sourceId: source.id,
      sourceName: source.name,
      language: source.language,
      sourceUrl: resolved,
      canonicalUrl,
      title: title.slice(0, 1_000),
      ...(summaryText ? { summary: summaryText } : {}),
      ...(discoveryBody ? { discoveryBody } : {}),
      contentStatus: discoveryBody ? "full" : "summary",
      publishedAt,
      ...(updatedAt ? { updatedAt } : {}),
      authors: stringList(item.author),
      publisherCategories: stringList(item.category),
      ...(upstreamId ? { upstreamId } : {}),
    });
  }

  return { source, transport: "rsshub-package", fetchedAt, upstream, candidates, version: RSSHUB_VERSION };
}

export async function discoverWithRssHub(source: SourceConfig, fetchedAt: string): Promise<DiscoveryResult> {
  if (source.discovery.kind !== "rsshub-package") throw new Error(`${source.id}: expected rsshub-package discovery`);
  const rsshub = await import("rsshub");
  const proxyUri = process.env.JOJO_TIMES_PROXY_URI?.trim();
  await rsshub.init({
    CACHE_TYPE: "memory",
    NO_LOGFILES: "1",
    REQUEST_RETRY: "1",
    ...(proxyUri ? { PROXY_URI: proxyUri, PROXY_STRATEGY: "all" } : {}),
  });
  const route = new URL(source.discovery.route, "https://rsshub.invalid");
  if (!route.searchParams.has("limit")) route.searchParams.set("limit", "500");
  const upstream = await rsshub.request(`${route.pathname}${route.search}`);
  return mapRssHubData(source, upstream, fetchedAt);
}
