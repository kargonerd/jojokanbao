import { load } from "cheerio";
import { fetchHtml, mapLimit } from "../../discovery/http.js";
import { articleId, normalizeArticleUrl } from "../../identity.js";
import { isFullDiscoveryBody, isoDate, plainText, stringList } from "../../text.js";
import type { Candidate, DiscoveryResult, RouteDiscoveryEndpoint, SourceConfig } from "../../types.js";

type Endpoint = RouteDiscoveryEndpoint;
type JsonObject = Record<string, unknown>;

const channelIds: Record<string, string> = {
  featured: "25949",
  international: "122908",
  "current-affairs": "25950",
  finance: "25951",
  thought: "25952",
  technology: "119908",
};

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  const row = object(value);
  return row ? text(row.name) : undefined;
}

function isVideo(detail: JsonObject): boolean {
  return [detail.videos, detail.videoDTOList, detail.audioVisualList]
    .some((value) => Array.isArray(value) ? value.length > 0 : Boolean(object(value)));
}

export async function discoverThepaper(
  source: SourceConfig,
  endpoint: Endpoint,
  fetchedAt: string,
): Promise<DiscoveryResult> {
  const channelId = channelIds[endpoint.route];
  if (!channelId) throw new Error(`${source.id}: unsupported route: ${endpoint.route}`);
  const api = "https://api.thepaper.cn/contentapi/nodeCont/getByChannelId";
  const response = await fetch(api, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "JOJO-Times-Offline/2.0 (+https://jojokanbao.cn)",
    },
    body: JSON.stringify({ channelId }),
    signal: AbortSignal.timeout(70_000),
  });
  if (!response.ok) throw new Error(`${source.id}: The Paper channel API returned HTTP ${response.status}`);
  const payload = object(await response.json());
  const data = object(payload?.data);
  const rows: JsonObject[] = (Array.isArray(data?.list) ? data.list : [])
    .map(object)
    .filter((value): value is JsonObject => value !== undefined)
    .slice(0, endpoint.maximumItems);
  const rowById = new Map(rows.flatMap((row) => {
    const id = text(row.contId);
    return id ? [[id, row] as const] : [];
  }));
  let failedPages = 0;
  let skippedVideos = 0;
  const candidates = await mapLimit<Candidate>([...rowById.keys()], 8, async (contId) => {
    const row = rowById.get(contId);
    if (!row) return undefined;
    const sourceUrl = text(row.link) ?? `https://m.thepaper.cn/detail/${contId}`;
    try {
      const document = load(await fetchHtml(source.id, sourceUrl));
      const nextData = object(JSON.parse(document("#__NEXT_DATA__").text()));
      const pageProps = object(object(nextData?.props)?.pageProps);
      const detailData = object(pageProps?.detailData);
      const specialDetail = object(detailData?.specialDetail);
      const detail = object(detailData?.contentDetail)
        ?? object(detailData?.liveDetail)
        ?? object(specialDetail?.specialInfo);
      if (!detail) return undefined;
      if (isVideo(detail)) {
        skippedVideos += 1;
        return undefined;
      }
      const title = plainText(text(detail.name) ?? text(detail.shareName) ?? text(row.name)).trim();
      const publishedAt = isoDate(detail.publishTime) ?? isoDate(row.pubTimeLong);
      if (!title || !publishedAt) return undefined;
      const canonicalUrl = normalizeArticleUrl(`https://www.thepaper.cn/newsDetail_forward_${contId}`);
      const renderedBody = text(detail.content);
      const discoveryBody = source.content.priority.includes("discovery-body") && renderedBody && isFullDiscoveryBody(
        renderedBody,
        source.content.minimumFullCharacters,
        source.content.minimumFullParagraphs,
      ) ? renderedBody : undefined;
      const summary = plainText(text(detail.summary) ?? text(detail.desc)).slice(0, 1_000) || undefined;
      const nodeInfo = object(detail.nodeInfo) ?? object(row.nodeInfo);
      const tags = (Array.isArray(detail.tagList) ? detail.tagList : []).flatMap((value) => {
        const tag = object(value);
        const name = text(tag?.tag) ?? text(tag?.name);
        return name ? [name] : [];
      });
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
        authors: stringList(detail.author),
        publisherCategories: [...new Set([
          ...stringList(nodeInfo?.name),
          ...tags,
          ...stringList(detail.tags),
        ])],
        upstreamId: contId,
      };
    } catch {
      failedPages += 1;
      return undefined;
    }
  });
  return {
    source,
    transport: "source-adapter",
    fetchedAt,
    version: "thepaper-channel/1",
    upstream: {
      endpoint: api,
      channelId,
      articleIds: [...rowById.keys()],
      parsedArticleCount: candidates.length,
      failedArticleCount: failedPages,
      skippedVideoCount: skippedVideos,
    },
    candidates,
  };
}
