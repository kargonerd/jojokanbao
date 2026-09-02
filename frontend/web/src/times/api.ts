import {
  JoxClient,
  resolveJoxObject,
  type JojoAssetDescriptor,
  type JojoFragment,
  type TimesDeliveryArticle,
  type TimesTimelineDay,
  type TimesTimelineDayRef,
  type TimesTimelineIndex,
  type TimesTimelinePage,
} from "@jojo/content";
import {
  preferredTimesTranslation,
  presentTimesArticle,
  type TimesForeignContentLanguage,
  type TimesPresentedArticle,
} from "./language";

const CONTENT_CDN = import.meta.env.VITE_CONTENT_CDN_BASE || "https://blacknews.jojokanbao.cn/";
const TIMELINE_INDEX_OBJECT = "content/timeline/index.jox";
export const TIMES_TIMELINE_FALLBACK_PAGE_SIZE = 50;
const MAX_CACHED_DAYS = 2;
const MAX_CACHED_PAGES = 6;
const MAX_CACHED_ARTICLES = TIMES_TIMELINE_FALLBACK_PAGE_SIZE * MAX_CACHED_PAGES;
const client = new JoxClient(CONTENT_CDN, (input, init) => fetch(input, init));

export type TimesNewsItem = TimesPresentedArticle & {
  content?: string | null;
  contentFormat?: "html" | "text";
  assetUrls?: Record<string, string>;
};

function asTimelineIndex(value: TimesTimelineIndex): TimesTimelineIndex {
  if (value.formatVersion !== "jojo-news-timeline-index/1" || !Array.isArray(value.dates) || !Array.isArray(value.sources)) {
    throw new Error("时事时间线索引格式无效");
  }
  return value;
}

function asTimelineDay(value: TimesTimelineDay, date: string): TimesTimelineDay {
  if (value.formatVersion !== "jojo-news-timeline-day/1" || value.date !== date || !Array.isArray(value.articles)) {
    throw new Error(`${date} 的时事时间线格式无效`);
  }
  return value;
}

function asTimelinePage(value: TimesTimelinePage, date: string, page: number): TimesTimelinePage {
  if (value.formatVersion !== "jojo-news-timeline-page/1"
    || value.date !== date
    || value.page !== page
    || !Array.isArray(value.articles)) {
    throw new Error(`${date} 的时事分页格式无效`);
  }
  return value;
}

function safeArticleObject(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!/^content\/newspapers\/[^/]+\/articles\/[^/]+\.jox$/u.test(normalized) || normalized.includes("../")) {
    throw new Error("时事文章对象路径无效");
  }
  return normalized;
}

function safeAssetObject(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!/^content\/newspapers\/[^/]+\/assets\/[^/]+\.jox$/u.test(normalized) || normalized.includes("../")) {
    throw new Error("时事图片对象路径无效");
  }
  return normalized;
}

let indexPromise: Promise<TimesTimelineIndex> | undefined;
const dayPromises = new Map<string, Promise<TimesTimelineDay>>();
const pagePromises = new Map<string, Promise<TimesTimelinePage>>();
const articleMetadata = new Map<string, TimesDeliveryArticle>();

function retainPromise<K, V>(cache: Map<K, Promise<V>>, key: K, promise: Promise<V>, maximum: number): void {
  cache.delete(key);
  cache.set(key, promise);
  while (cache.size > maximum) {
    const oldest = cache.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function cachedPromise<K, V>(cache: Map<K, Promise<V>>, key: K): Promise<V> | undefined {
  const promise = cache.get(key);
  if (promise) {
    cache.delete(key);
    cache.set(key, promise);
  }
  return promise;
}

function rememberArticles(articles: readonly TimesDeliveryArticle[]): void {
  for (const article of articles.slice(0, MAX_CACHED_ARTICLES)) {
    articleMetadata.delete(article.id);
    articleMetadata.set(article.id, article);
  }
  while (articleMetadata.size > MAX_CACHED_ARTICLES) {
    const oldest = articleMetadata.keys().next().value;
    if (oldest === undefined) break;
    articleMetadata.delete(oldest);
  }
}

function cachedArticle(issueDate: string, newsId: string): TimesDeliveryArticle | undefined {
  const article = articleMetadata.get(newsId);
  if (!article || article.issueDate !== issueDate) return undefined;
  articleMetadata.delete(newsId);
  articleMetadata.set(newsId, article);
  return article;
}

async function assetObjectUrl(asset: JojoAssetDescriptor, signal?: AbortSignal): Promise<string> {
  return URL.createObjectURL(await assetObjectBlob(asset, signal));
}

async function assetObjectBlob(asset: JojoAssetDescriptor, signal?: AbortSignal): Promise<Blob> {
  const bytes = await client.fetchDecodedBytes(safeAssetObject(asset.object), signal);
  return new Blob([Uint8Array.from(bytes).buffer], { type: asset.mediaType });
}

async function timelineIndex(refresh = false): Promise<TimesTimelineIndex> {
  if (refresh || !indexPromise) {
    indexPromise = client.fetchJson<TimesTimelineIndex>(TIMELINE_INDEX_OBJECT, undefined, "no-store").then(asTimelineIndex);
  }
  try {
    return await indexPromise;
  } catch (error) {
    indexPromise = undefined;
    throw error;
  }
}

async function timelineDay(date: string, refresh = false): Promise<TimesTimelineDay> {
  const index = await timelineIndex();
  const ref = index.dates.find((candidate) => candidate.date === date);
  if (!ref) throw new Error(`没有 ${date} 的时事数据`);
  let promise = refresh ? undefined : cachedPromise(dayPromises, date);
  if (!promise) {
    const object = resolveJoxObject(TIMELINE_INDEX_OBJECT, ref.object);
    promise = client.fetchJson<TimesTimelineDay>(object, undefined, "no-store").then((value) => asTimelineDay(value, date));
    retainPromise(dayPromises, date, promise, MAX_CACHED_DAYS);
  }
  try {
    return await promise;
  } catch (error) {
    if (dayPromises.get(date) === promise) dayPromises.delete(date);
    throw error;
  }
}

export function timesTimelinePageCount(ref: TimesTimelineDayRef): number {
  return ref.pages?.length ?? Math.ceil(ref.articleCount / TIMES_TIMELINE_FALLBACK_PAGE_SIZE);
}

async function timelinePage(date: string, page: number, refresh = false): Promise<TimesTimelinePage> {
  if (!Number.isInteger(page) || page < 0) throw new Error("时事页码无效");
  const index = await timelineIndex();
  const ref = index.dates.find((candidate) => candidate.date === date);
  if (!ref) throw new Error(`没有 ${date} 的时事数据`);
  if (page >= timesTimelinePageCount(ref)) throw new Error(`没有 ${date} 的第 ${page + 1} 页时事数据`);

  const pageRef = ref.pages?.[page];
  if (!pageRef) {
    const day = await timelineDay(date, refresh);
    const offset = page * TIMES_TIMELINE_FALLBACK_PAGE_SIZE;
    const value: TimesTimelinePage = {
      formatVersion: "jojo-news-timeline-page/1",
      date,
      page,
      updatedAt: day.updatedAt,
      articles: day.articles.slice(offset, offset + TIMES_TIMELINE_FALLBACK_PAGE_SIZE),
    };
    rememberArticles(value.articles);
    return value;
  }

  const key = `${date}:${page}`;
  let promise = refresh ? undefined : cachedPromise(pagePromises, key);
  if (!promise) {
    const object = resolveJoxObject(TIMELINE_INDEX_OBJECT, pageRef.object);
    promise = client.fetchJson<TimesTimelinePage>(object, undefined, "no-store")
      .then((value) => asTimelinePage(value, date, page));
    retainPromise(pagePromises, key, promise, MAX_CACHED_PAGES);
  }
  try {
    const value = await promise;
    rememberArticles(value.articles);
    return value;
  } catch (error) {
    if (pagePromises.get(key) === promise) pagePromises.delete(key);
    throw error;
  }
}

export const timesApi = {
  timelineIndex,
  timelineDay,
  timelinePage,
  assetObjectUrl,
  assetObjectBlob,

  invalidate() {
    indexPromise = undefined;
    dayPromises.clear();
    pagePromises.clear();
    articleMetadata.clear();
  },

  async getNews(
    issueDate: string,
    newsId: string,
    languagePreference: TimesForeignContentLanguage = "zh-CN",
  ): Promise<TimesNewsItem> {
    const item = cachedArticle(issueDate, newsId)
      ?? (await timelineDay(issueDate)).articles.find((candidate) => candidate.id === newsId);
    if (!item) throw new Error("新闻不存在");
    const translation = languagePreference === "zh-CN" ? preferredTimesTranslation(item) : undefined;
    const fetchFragment = async (object: string): Promise<JojoFragment> => {
      const fragment = await client.fetchJson<JojoFragment>(safeArticleObject(object));
      if (fragment.formatVersion !== "jojo-fragment/1" || fragment.type !== "article" || fragment.fragmentId !== item.id) {
        throw new Error("时事文章对象格式无效");
      }
      return fragment;
    };
    let fragment: JojoFragment;
    let usingTranslation = Boolean(translation);
    try {
      fragment = await fetchFragment(translation?.articleObject ?? item.articleObject);
    } catch (error) {
      if (!translation) throw error;
      fragment = await fetchFragment(item.articleObject);
      usingTranslation = false;
    }
    const referencedAssetIds = new Set(fragment.assetRefs);
    const assets = item.assets.filter((asset) => referencedAssetIds.has(asset.id));
    const pairs = await Promise.all(assets.map(async (asset) => {
      try {
        return [asset.id, await assetObjectUrl(asset)] as const;
      } catch {
        return undefined;
      }
    }));
    return {
      ...presentTimesArticle(item, usingTranslation ? "zh-CN" : "original"),
      ...(!usingTranslation && translation ? { title: fragment.title, summary: null, language: item.source.language } : {}),
      assets,
      content: fragment.body.value,
      contentFormat: fragment.body.format,
      assetUrls: Object.fromEntries(pairs.filter((pair): pair is readonly [string, string] => Boolean(pair))),
    };
  },
};
