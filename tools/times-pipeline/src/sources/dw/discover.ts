import { articleId, normalizeArticleUrl } from "../../identity.js";
import { publisherDate, optionalString, plainText, stringList } from "../../text.js";
import type { Candidate, DiscoveryEndpoint, DiscoveryResult, SourceConfig } from "../../types.js";

type DwEndpoint = Extract<DiscoveryEndpoint, { kind: "source-adapter"; adapter: "dw" }>;
type JsonObject = Record<string, unknown>;

const ROOT = "https://www.dw.com";

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function contentRows(content: JsonObject): JsonObject[] {
  const composition = object(content.contentComposition);
  const spaces = Array.isArray(composition?.informationSpaces) ? composition.informationSpaces : [];
  return spaces.flatMap((space) => {
    const row = object(space);
    if (!row) return [];
    return Object.values(row).flatMap((components) => {
      if (!Array.isArray(components)) return [];
      const component = object(components[0]);
      if (!Array.isArray(component?.contents)) return [];
      return component.contents.map(object).filter((item): item is JsonObject => Boolean(item));
    });
  });
}

function mapCandidate(source: SourceConfig, item: JsonObject): Candidate | undefined {
  const type = optionalString(item.__typename);
  if (type !== "Article" && type !== "Liveblog") return undefined;
  const id = optionalString(item.id);
  const namedUrl = optionalString(item.namedUrl);
  const title = plainText(item.title ?? item.name);
  const publishedAt = publisherDate(item.contentDate, source.publicationTimeZone);
  if (!id || !namedUrl || !title || !publishedAt) return undefined;
  const sourceUrl = new URL(namedUrl, ROOT).href;
  const canonicalUrl = normalizeArticleUrl(sourceUrl);
  const summary = plainText(item.teaser).slice(0, 1_000) || undefined;
  return {
    articleId: articleId(source.id, canonicalUrl),
    sourceId: source.id,
    sourceName: source.name,
    language: source.language,
    sourceUrl,
    canonicalUrl,
    title: title.slice(0, 1_000),
    ...(summary ? { summary } : {}),
    contentStatus: summary ? "summary" : "metadata",
    publishedAt,
    authors: [],
    publisherCategories: stringList(item.trackingCategories),
    upstreamId: id,
  };
}

export async function discoverDw(source: SourceConfig, endpoint: DwEndpoint, fetchedAt: string): Promise<DiscoveryResult> {
  const url = `${ROOT}/graph-api/en/content/navigation/${endpoint.navigationId}`;
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "JOJO-Times-Offline/2.0 (+https://jojokanbao.cn)" },
    signal: AbortSignal.timeout(70_000),
  });
  if (!response.ok) throw new Error(`${source.id}: DW API returned HTTP ${response.status}`);
  const payload: unknown = await response.json();
  const data = object(object(payload)?.data);
  const content = object(data?.content);
  if (!content) throw new Error(`${source.id}: DW API omitted content`);
  const candidates = new Map<string, Candidate>();
  for (const item of contentRows(content)) {
    const candidate = mapCandidate(source, item);
    if (candidate) candidates.set(candidate.articleId, candidate);
  }
  return {
    source,
    transport: "source-adapter",
    fetchedAt,
    upstream: payload,
    candidates: [...candidates.values()]
      .toSorted((left, right) => right.publishedAt.localeCompare(left.publishedAt))
      .slice(0, endpoint.maximumItems),
    version: "dw-navigation-api/1",
  };
}
