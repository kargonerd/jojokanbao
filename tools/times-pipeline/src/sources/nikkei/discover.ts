import { articleId, normalizeArticleUrl } from "../../identity.js";
import { discoverHtmlListing, sectionUrl } from "../../discovery/html-listing.js";
import { isoDate, optionalString, plainText, stringList } from "../../text.js";
import type { Candidate, DiscoveryEndpoint, DiscoveryResult, SourceConfig } from "../../types.js";

type NikkeiEndpoint = Extract<DiscoveryEndpoint, { kind: "source-adapter"; adapter: "nikkei" }>;
type JsonObject = Record<string, unknown>;

const ROOT = "https://asia.nikkei.com";
const API = `${ROOT}/api/__service/next_api/v1/graphql`;
const PERSISTED_QUERY = "287aed8784a3f55ad444bb6b550ebdafb40b0da60c7800081e7343d889975fe8";

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function rows(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(object).filter((row): row is JsonObject => Boolean(row)) : [];
}

function mapCandidate(source: SourceConfig, item: JsonObject): Candidate | undefined {
  const title = plainText(item.name);
  const path = optionalString(item.path);
  const timestamp = typeof item.displayDate === "number" ? item.displayDate * 1_000 : item.displayDate;
  const publishedAt = isoDate(timestamp);
  if (!title || !path || !publishedAt) return undefined;
  const sourceUrl = new URL(path, ROOT).href;
  const canonicalUrl = normalizeArticleUrl(sourceUrl);
  const primaryTag = object(item.primaryTag);
  const upstreamId = optionalString(item.remoteId);
  return {
    articleId: articleId(source.id, canonicalUrl),
    sourceId: source.id,
    sourceName: source.name,
    language: source.language,
    sourceUrl,
    canonicalUrl,
    title: title.slice(0, 1_000),
    contentStatus: "metadata",
    publishedAt,
    authors: [],
    publisherCategories: stringList(primaryTag?.name),
    ...(upstreamId ? { upstreamId } : {}),
  };
}

async function discoverLatest(source: SourceConfig, endpoint: NikkeiEndpoint, fetchedAt: string): Promise<DiscoveryResult> {
  if (!("stream" in endpoint)) throw new Error(`${source.id}: expected latest stream endpoint`);
  const url = new URL(API);
  url.searchParams.set("operationName", "GetLatestHeadlinesStream");
  url.searchParams.set("variables", "{}");
  url.searchParams.set("extensions", JSON.stringify({ persistedQuery: { version: 1, sha256Hash: PERSISTED_QUERY } }));
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "JOJO-Times-Offline/2.0 (+https://jojokanbao.cn)",
    },
    signal: AbortSignal.timeout(70_000),
  });
  if (!response.ok) throw new Error(`${source.id}: Nikkei API returned HTTP ${response.status}`);
  const payload: unknown = await response.json();
  const data = object(object(payload)?.data);
  const headlines = object(data?.getLatestHeadlines);
  const candidates = new Map<string, Candidate>();
  for (const item of rows(headlines?.items)) {
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
    version: "nikkei-graphql/1",
  };
}

const pathPrefixes: Record<string, string[]> = {
  china: ["/"],
  japan: ["/"],
  "southeast-asia": ["/"],
  india: ["/"],
  "east-asia": ["/"],
  "south-asia": ["/"],
  "central-asia": ["/"],
  oceania: ["/"],
  business: ["/business/"],
  markets: ["/business/markets/"],
  tech: ["/business/technology/", "/business/tech/"],
  politics: ["/politics/"],
  economy: ["/economy/"],
};

export async function discoverNikkei(source: SourceConfig, endpoint: NikkeiEndpoint, fetchedAt: string): Promise<DiscoveryResult> {
  if ("stream" in endpoint) return discoverLatest(source, endpoint, fetchedAt);
  const prefixes = pathPrefixes[endpoint.route];
  if (!prefixes) throw new Error(`${source.id}: unsupported route: ${endpoint.route}`);
  return discoverHtmlListing(source, fetchedAt, {
    listingUrl: sectionUrl(source, endpoint.route),
    articlePathPrefixes: prefixes,
    linkSelector: "[class*='ArticleCard'][class*='Headline'] a[href]",
    maximumItems: endpoint.maximumItems,
    bodySelectors: [".article-body", ".article__body"],
    version: "nikkei-html/1",
  });
}
