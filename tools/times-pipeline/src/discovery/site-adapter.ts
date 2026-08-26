import { load } from "cheerio";
import { articleId, normalizeArticleUrl } from "../identity.js";
import { isFullDiscoveryBody, isoDate, plainText, stringList } from "../text.js";
import type { Candidate, DiscoveryResult, SourceConfig } from "../types.js";

type JsonObject = Record<string, unknown>;

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
      // Ignore malformed JSON-LD blocks and continue with metadata fallbacks.
    }
  });
  const articleTypes = new Set(["article", "newsarticle", "reportagenewsarticle", "analysisnewsarticle"]);
  return rows.find((row) => values(row["@type"]).some((type) => articleTypes.has(type.toLowerCase())));
}

function articleLinks(html: string, pageUrl: string, prefixes: string[], maximumItems: number, selector = "a[href]"): string[] {
  const page = new URL(pageUrl);
  const document = load(html);
  const links: string[] = [];
  const seen = new Set<string>();
  document(selector).each((_, element) => {
    const href = document(element).attr("href");
    if (!href || links.length >= maximumItems) return;
    try {
      const url = new URL(href, page);
      if (url.origin !== page.origin || !prefixes.some((prefix) => url.pathname.startsWith(prefix))) return;
      url.hash = "";
      const normalized = url.toString();
      if (seen.has(normalized)) return;
      seen.add(normalized);
      links.push(normalized);
    } catch {
      // Ignore invalid page links.
    }
  });
  return links;
}

function bodyHtml(value: string): string {
  const escaped = value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const paragraphs = escaped.split(/\r?\n(?:\s*\r?\n)*/u).map((part) => part.trim()).filter(Boolean);
  return paragraphs.map((part) => `<p>${part}</p>`).join("");
}

function publicationDate(value: unknown, language: string): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  if (language.toLowerCase().startsWith("zh") && /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/u.test(raw)) {
    const local = raw.length === 10 ? `${raw}T00:00:00+08:00` : `${raw.replace(" ", "T")}+08:00`;
    return isoDate(local);
  }
  return isoDate(raw);
}

function fallbackBody(document: ReturnType<typeof load>): string | undefined {
  const container = document("[itemprop='articleBody'], #detailContent, .left_zw, .article-body, .article__body, .content_desc, article").first();
  if (!container.length) return undefined;
  container.find("script, style, nav, footer, header, aside, form, noscript, .adInContent").remove();
  return container.html()?.trim() || undefined;
}

async function fetchHtml(sourceId: string, url: string): Promise<string> {
  const cached = htmlCache.get(url);
  if (cached) return cached;
  const pending = (async () => {
    const response = await fetch(url, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "JOJO-Times-Offline/2.0 (+https://jojokanbao.cn)",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(70_000),
    });
    if (!response.ok) throw new Error(`${sourceId}: HTML page returned HTTP ${response.status}: ${url}`);
    return response.text();
  })();
  htmlCache.set(url, pending);
  try {
    return await pending;
  } catch (error) {
    htmlCache.delete(url);
    throw error;
  }
}

const htmlCache = new Map<string, Promise<string>>();

async function mapLimit<T>(values: string[], concurrency: number, work: (value: string) => Promise<T | undefined>): Promise<T[]> {
  const results: T[] = [];
  let cursor = 0;
  async function consume(): Promise<void> {
    while (cursor < values.length) {
      const value = values[cursor++];
      if (!value) return;
      const result = await work(value);
      if (result !== undefined) results.push(result);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, consume));
  return results;
}

function isThepaperVideo(detail: JsonObject): boolean {
  const videoFields = [detail.videos, detail.videoDTOList, detail.audioVisualList];
  return videoFields.some((value) => Array.isArray(value) ? value.length > 0 : Boolean(object(value)));
}

async function discoverThepaperChannel(source: SourceConfig, fetchedAt: string): Promise<DiscoveryResult> {
  if (source.discovery.kind !== "site-adapter" || source.discovery.adapter !== "thepaper-channel") {
    throw new Error(`${source.id}: expected thepaper-channel adapter`);
  }
  const endpoint = "https://api.thepaper.cn/contentapi/nodeCont/getByChannelId";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "JOJO-Times-Offline/2.0 (+https://jojokanbao.cn)",
    },
    body: JSON.stringify({ channelId: source.discovery.channelId }),
    signal: AbortSignal.timeout(70_000),
  });
  if (!response.ok) throw new Error(`${source.id}: The Paper channel API returned HTTP ${response.status}`);
  const payload = object(await response.json());
  const data = object(payload?.data);
  const rows: JsonObject[] = (Array.isArray(data?.list) ? data.list : [])
    .map(object)
    .filter((value): value is JsonObject => value !== undefined)
    .slice(0, source.discovery.maximumItems);
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
      const html = await fetchHtml(source.id, sourceUrl);
      const document = load(html);
      const nextData = object(JSON.parse(document("#__NEXT_DATA__").text()));
      const pageProps = object(object(nextData?.props)?.pageProps);
      const detailData = object(pageProps?.detailData);
      const specialDetail = object(detailData?.specialDetail);
      const detail = object(detailData?.contentDetail)
        ?? object(detailData?.liveDetail)
        ?? object(specialDetail?.specialInfo);
      if (!detail) return undefined;
      if (isThepaperVideo(detail)) {
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
    transport: "site-adapter",
    fetchedAt,
    upstream: {
      endpoint,
      channelId: source.discovery.channelId,
      articleIds: [...rowById.keys()],
      parsedArticleCount: candidates.length,
      failedArticleCount: failedPages,
      skippedVideoCount: skippedVideos,
    },
    candidates,
  };
}

export async function discoverSiteAdapter(source: SourceConfig, fetchedAt: string): Promise<DiscoveryResult> {
  if (source.discovery.kind !== "site-adapter") throw new Error(`${source.id}: expected site adapter`);
  if (source.discovery.adapter === "thepaper-channel") return discoverThepaperChannel(source, fetchedAt);
  const listingHtml = await fetchHtml(source.id, source.discovery.url);
  const links = articleLinks(
    listingHtml,
    source.discovery.url,
    source.discovery.articlePathPrefixes,
    source.discovery.maximumItems,
    source.discovery.linkSelector,
  );
  let failedPages = 0;
  const candidates = await mapLimit<Candidate>(links, 8, async (sourceUrl) => {
    try {
      const html = await fetchHtml(source.id, sourceUrl);
      const document = load(html);
      const json = articleJson(html);
      const title = plainText(
        text(json?.headline)
          ?? document('meta[property="og:title"]').attr("content")
          ?? document("h1").first().text()
          ?? document("title").text(),
      ).trim();
      const publishedAt = publicationDate(json?.datePublished, source.language)
        ?? publicationDate(document('meta[property="article:published_time"]').attr("content"), source.language)
        ?? publicationDate(document('meta[name="publishdate"], meta[name="date"]').first().attr("content"), source.language)
        ?? publicationDate(document("time[datetime]").first().attr("datetime"), source.language)
        ?? publicationDate(document("#pubtime_baidu, .pubtime").first().text(), source.language);
      if (!title || !publishedAt) return undefined;
      const declaredUrl = text(json?.url) ?? document('link[rel="canonical"]').attr("href") ?? sourceUrl;
      const canonicalUrl = normalizeArticleUrl(new URL(declaredUrl, sourceUrl).toString());
      const rawBody = text(json?.articleBody);
      const renderedBody = rawBody ? bodyHtml(rawBody) : fallbackBody(document);
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
    } catch {
      // A malformed or blocked article must not discard the rest of the section page.
      failedPages += 1;
      return undefined;
    }
  });
  return {
    source,
    transport: "site-adapter",
    fetchedAt,
    upstream: {
      pageUrl: source.discovery.url,
      articleUrls: links,
      parsedArticleCount: candidates.length,
      failedArticleCount: failedPages,
    },
    candidates,
  };
}
