import { createHash } from "node:crypto";
import { articleId, normalizeArticleUrl } from "../../identity.js";
import { isoDate, optionalString, plainText, stringList } from "../../text.js";
import type { Candidate, DiscoveryEndpoint, DiscoveryResult, SourceConfig } from "../../types.js";

type ClsEndpoint = Extract<DiscoveryEndpoint, { kind: "source-adapter"; adapter: "cls" }>;
type JsonObject = Record<string, unknown>;

const ROOT = "https://www.cls.cn";

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function rows(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(object).filter((row): row is JsonObject => Boolean(row)) : [];
}

function signedParams(): URLSearchParams {
  const params = new URLSearchParams({ appName: "CailianpressWeb", os: "web", sv: "8.7.9" });
  params.sort();
  const sha1 = createHash("sha1").update(params.toString()).digest("hex");
  params.set("sign", createHash("md5").update(sha1).digest("hex"));
  return params;
}

function mapCandidate(source: SourceConfig, row: JsonObject): Candidate | undefined {
  const id = optionalString(row.id);
  const title = plainText(row.title ?? row.brief);
  const timestamp = typeof row.ctime === "number" ? row.ctime * 1_000 : row.ctime;
  const publishedAt = isoDate(timestamp);
  if (!id || !title || !publishedAt) return undefined;
  const sourceUrl = `${ROOT}/detail/${id}`;
  const canonicalUrl = normalizeArticleUrl(sourceUrl);
  const brief = plainText(row.brief);
  const summary = brief && brief !== title ? brief.slice(0, 1_000) : undefined;
  const tags = rows(row.tags).flatMap((tag) => stringList(tag.name));
  const subjects = rows(row.subjects).flatMap((subject) => stringList(subject.subject_name));
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
    authors: stringList(row.author ?? row.source),
    publisherCategories: [...new Set([...tags, ...subjects])],
    upstreamId: id,
  };
}

export async function discoverCls(source: SourceConfig, endpoint: ClsEndpoint, fetchedAt: string): Promise<DiscoveryResult> {
  const url = new URL(`${ROOT}/v3/depth/home/assembled/${endpoint.categoryId}`);
  url.search = signedParams().toString();
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "JOJO-Times-Offline/2.0 (+https://jojokanbao.cn)" },
    signal: AbortSignal.timeout(70_000),
  });
  if (!response.ok) throw new Error(`${source.id}: CLS API returned HTTP ${response.status}`);
  const payload: unknown = await response.json();
  const data = object(object(payload)?.data);
  const candidates = new Map<string, Candidate>();
  for (const row of [...rows(data?.top_article), ...rows(data?.depth_list)]) {
    const candidate = mapCandidate(source, row);
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
    version: "cls-depth-api/1",
  };
}
