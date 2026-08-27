import { articleId, normalizeArticleUrl } from "../../identity.js";
import { publisherDate, optionalString, plainText, stringList } from "../../text.js";
import type { Candidate, DiscoveryEndpoint, DiscoveryResult, SourceConfig } from "../../types.js";

type ApEndpoint = Extract<DiscoveryEndpoint, { kind: "source-adapter"; adapter: "ap" }>;
type JsonObject = Record<string, unknown>;

const AP_ROOT = "https://apnews.com";
const AP_API = `${AP_ROOT}/graphql/delivery/ap/v1`;
const PERSISTED_QUERY = "3bc305abbf62e9e632403a74cc86dc1cba51156d2313f09b3779efec51fc3acb";
const EXCLUDED_RECOMMENDATION_CATEGORIES = new Set(["entertainment", "lifestyle", "sports"]);

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function objects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(object).filter((row): row is JsonObject => Boolean(row)) : [];
}

function pagePromos(payload: unknown): JsonObject[] {
  const root = object(payload);
  const data = object(root?.data);
  const screen = object(data?.Screen);
  const modules = objects(screen?.main).flatMap((module) =>
    module.__typename === "ColumnContainer" ? objects(module.columns) : [module]
  );
  return modules.flatMap((module) => module.__typename === "PageListModule" ? objects(module.items) : [])
    .filter((item) => item.__typename === "PagePromo");
}

function candidate(source: SourceConfig, item: JsonObject): Candidate | undefined {
  const title = plainText(item.title);
  const rawLink = optionalString(item.url);
  const publishedAt = publisherDate(item.publishDateStamp, source.publicationTimeZone);
  if (!title || !rawLink || !publishedAt) return;
  const publisherCategories = stringList(item.category);
  if (publisherCategories.some((category) => EXCLUDED_RECOMMENDATION_CATEGORIES.has(category.toLowerCase()))) return;
  let canonicalUrl: string;
  try { canonicalUrl = normalizeArticleUrl(new URL(rawLink, AP_ROOT).href); } catch { return; }
  const summary = plainText(item.description).slice(0, 1_000) || undefined;
  const upstreamId = optionalString(item.id);
  return {
    articleId: articleId(source.id, canonicalUrl), sourceId: source.id, sourceName: source.name,
    language: source.language, sourceUrl: new URL(rawLink, AP_ROOT).href, canonicalUrl,
    title: title.slice(0, 1_000), ...(summary ? { summary } : {}),
    contentStatus: summary ? "summary" : "metadata", publishedAt, authors: [],
    publisherCategories, ...(upstreamId ? { upstreamId } : {}),
  };
}

export async function discoverAp(source: SourceConfig, endpoint: ApEndpoint, fetchedAt: string): Promise<DiscoveryResult> {
  const url = new URL(AP_API);
  url.searchParams.set("operationName", "ContentPageQuery");
  url.searchParams.set("variables", JSON.stringify({ path: endpoint.path }));
  url.searchParams.set("extensions", JSON.stringify({ persistedQuery: { version: 1, sha256Hash: PERSISTED_QUERY } }));
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${source.id}: AP API returned HTTP ${response.status}`);
  const payload: unknown = await response.json();
  const candidates = new Map<string, Candidate>();
  for (const item of pagePromos(payload)) {
    const row = candidate(source, item);
    if (row) candidates.set(row.articleId, row);
  }
  return {
    source, transport: "source-adapter", fetchedAt, upstream: payload,
    candidates: [...candidates.values()].toSorted((left, right) => right.publishedAt.localeCompare(left.publishedAt)).slice(0, endpoint.maximumItems),
    version: "ap-graphql/1",
  };
}
