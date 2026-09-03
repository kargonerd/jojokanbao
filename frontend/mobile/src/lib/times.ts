import {
  JoxClient,
  asJojoFragment,
  resolveJoxObject,
  type JojoAssetDescriptor,
  type TimesArticleTranslation,
  type TimesDeliveryArticle,
  type TimesTimelineDay,
  type TimesTimelineDayRef,
  type TimesTimelineIndex,
  type TimesTimelinePage,
} from "@jojo/content";

const CONTENT_CDN = process.env.EXPO_PUBLIC_CONTENT_CDN_BASE?.trim()
  || "https://blacknews.jojokanbao.cn/";
const TIMELINE_INDEX_OBJECT = "content/timeline/index.jox";
export const TIMES_TIMELINE_FALLBACK_PAGE_SIZE = 50;
const MAX_CACHED_DAYS = 2;
const MAX_CACHED_PAGES = 6;
const MAX_CACHED_ARTICLES = TIMES_TIMELINE_FALLBACK_PAGE_SIZE * MAX_CACHED_PAGES;
const MAX_CACHED_IMAGES = 36;

export type MobileTimesLanguage = "zh-CN" | "original";

export type MobileTimesArticle = TimesDeliveryArticle & {
  originalLanguage: string;
  translationAvailable: boolean;
  usingTranslation: boolean;
};

export type MobileTimesNewsItem = MobileTimesArticle & {
  content?: string | null;
  contentFormat?: "html" | "text";
  assetUrls?: Record<string, string>;
};

export type TimesTimelineCursor = { dateIndex: number; page: number };

const client = new JoxClient(CONTENT_CDN, (input, init) => fetch(input, init));
let indexPromise: Promise<TimesTimelineIndex> | undefined;
const dayPromises = new Map<string, Promise<TimesTimelineDay>>();
const pagePromises = new Map<string, Promise<TimesTimelinePage>>();
const articleMetadata = new Map<string, TimesDeliveryArticle>();
const imagePromises = new Map<string, Promise<string>>();

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

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += alphabet[first >> 2];
    output += alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)];
    output += second === undefined ? "=" : alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)];
    output += third === undefined ? "=" : alphabet[third & 63];
  }
  return output;
}

export function preferredTimesTranslation(article: TimesDeliveryArticle): TimesArticleTranslation | undefined {
  const translation = article.translations?.["zh-CN"];
  if (!translation || translation.language !== "zh-CN" || typeof translation.title !== "string"
    || typeof translation.articleObject !== "string") return undefined;
  return translation;
}

export function presentMobileTimesArticle(
  article: TimesDeliveryArticle,
  preference: MobileTimesLanguage,
): MobileTimesArticle {
  const translation = preferredTimesTranslation(article);
  const usingTranslation = preference === "zh-CN" && Boolean(translation);
  return {
    ...article,
    ...(usingTranslation && translation ? {
      title: translation.title,
      summary: translation.summary ?? null,
      language: translation.language,
    } : {}),
    originalLanguage: article.source.language,
    translationAvailable: Boolean(translation),
    usingTranslation,
  };
}

export function timesTimelinePageCount(ref: TimesTimelineDayRef): number {
  return ref.pages?.length ?? Math.ceil(ref.articleCount / TIMES_TIMELINE_FALLBACK_PAGE_SIZE);
}

export function firstTimesTimelineCursor(index: TimesTimelineIndex): TimesTimelineCursor | null {
  const dateIndex = index.dates.findIndex((date) => timesTimelinePageCount(date) > 0);
  return dateIndex >= 0 ? { dateIndex, page: 0 } : null;
}

export function nextTimesTimelineCursor(
  index: TimesTimelineIndex,
  cursor: TimesTimelineCursor,
): TimesTimelineCursor | null {
  const current = index.dates[cursor.dateIndex];
  if (current && cursor.page + 1 < timesTimelinePageCount(current)) {
    return { dateIndex: cursor.dateIndex, page: cursor.page + 1 };
  }
  for (let dateIndex = cursor.dateIndex + 1; dateIndex < index.dates.length; dateIndex += 1) {
    const date = index.dates[dateIndex];
    if (date && timesTimelinePageCount(date) > 0) return { dateIndex, page: 0 };
  }
  return null;
}

async function timelineIndex(refresh = false): Promise<TimesTimelineIndex> {
  if (refresh || !indexPromise) {
    indexPromise = client.fetchJson<TimesTimelineIndex>(TIMELINE_INDEX_OBJECT, undefined, "no-store")
      .then(asTimelineIndex);
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
    promise = client.fetchJson<TimesTimelineDay>(object, undefined, "no-store")
      .then((value) => asTimelineDay(value, date));
    retainPromise(dayPromises, date, promise, MAX_CACHED_DAYS);
  }
  try {
    return await promise;
  } catch (error) {
    if (dayPromises.get(date) === promise) dayPromises.delete(date);
    throw error;
  }
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
    const result: TimesTimelinePage = {
      formatVersion: "jojo-news-timeline-page/1",
      date,
      page,
      updatedAt: day.updatedAt,
      articles: day.articles.slice(offset, offset + TIMES_TIMELINE_FALLBACK_PAGE_SIZE),
    };
    rememberArticles(result.articles);
    return result;
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
    const result = await promise;
    rememberArticles(result.articles);
    return result;
  } catch (error) {
    if (pagePromises.get(key) === promise) pagePromises.delete(key);
    throw error;
  }
}

export async function loadTimesAssetBytes(asset: JojoAssetDescriptor, signal?: AbortSignal): Promise<Uint8Array> {
  return client.fetchDecodedBytes(safeAssetObject(asset.object), signal);
}

export function loadTimesAssetDataUri(asset: JojoAssetDescriptor, signal?: AbortSignal): Promise<string> {
  const key = `${asset.object}\0${asset.sha256}`;
  let promise = imagePromises.get(key);
  if (!promise) {
    promise = loadTimesAssetBytes(asset, signal).then((bytes) => `data:${asset.mediaType};base64,${bytesToBase64(bytes)}`);
    retainPromise(imagePromises, key, promise, MAX_CACHED_IMAGES);
  }
  return promise.catch((error: unknown) => {
    if (imagePromises.get(key) === promise) imagePromises.delete(key);
    throw error;
  });
}

export function leadTimesImage(article: Pick<TimesDeliveryArticle, "assets">): JojoAssetDescriptor | undefined {
  return article.assets.find((asset) => asset.type === "image" && asset.role === "lead")
    ?? article.assets.find((asset) => asset.type === "image");
}

export const mobileTimesApi = {
  timelineIndex,
  timelineDay,
  timelinePage,
  loadAssetDataUri: loadTimesAssetDataUri,
  loadAssetBytes: loadTimesAssetBytes,

  invalidate() {
    indexPromise = undefined;
    dayPromises.clear();
    pagePromises.clear();
    articleMetadata.clear();
    imagePromises.clear();
  },

  async getNews(
    issueDate: string,
    newsId: string,
    languagePreference: MobileTimesLanguage = "zh-CN",
  ): Promise<MobileTimesNewsItem> {
    const cached = articleMetadata.get(newsId);
    const item = cached?.issueDate === issueDate
      ? cached
      : (await timelineDay(issueDate)).articles.find((candidate) => candidate.id === newsId);
    if (!item) throw new Error("新闻不存在");
    const translation = languagePreference === "zh-CN" ? preferredTimesTranslation(item) : undefined;
    const fetchFragment = async (object: string) => {
      const fragment = asJojoFragment(await client.fetchJson<unknown>(safeArticleObject(object), undefined, "no-store"));
      if (fragment.type !== "article" || fragment.fragmentId !== item.id) {
        throw new Error("时事文章对象格式无效");
      }
      return fragment;
    };
    let fragment;
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
        return [asset.id, await loadTimesAssetDataUri(asset)] as const;
      } catch {
        return undefined;
      }
    }));
    return {
      ...presentMobileTimesArticle(item, usingTranslation ? "zh-CN" : "original"),
      ...(!usingTranslation && translation ? { title: fragment.title, summary: null, language: item.source.language } : {}),
      assets,
      content: fragment.body.value,
      contentFormat: fragment.body.format,
      assetUrls: Object.fromEntries(pairs.filter((pair): pair is readonly [string, string] => Boolean(pair))),
    };
  },
};

const SOURCE_DISPLAY_NAMES: Record<string, string> = { scmp: "南华早报" };

export function timesSourceName(source: { id: string; name: string }): string {
  return SOURCE_DISPLAY_NAMES[source.id] || source.name;
}

export function relativeTimesArticleTime(value: string, now = Date.now()): string {
  const timestamp = new Date(value).valueOf();
  if (Number.isNaN(timestamp)) return "时间未知";
  const elapsedMinutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (elapsedMinutes < 1) return "刚刚";
  if (elapsedMinutes < 60) return `${elapsedMinutes}分钟前`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}小时前`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}天前`;
  if (elapsedDays < 30) return `${Math.floor(elapsedDays / 7)}周前`;
  if (elapsedDays < 365) return `${Math.floor(elapsedDays / 30)}个月前`;
  return `${Math.floor(elapsedDays / 365)}年前`;
}

export function exactTimesArticleTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "时间未知" : new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function publisherTimesUpdatedAt(
  article: Pick<TimesDeliveryArticle, "publishedAt" | "updatedAt">,
): string | undefined {
  if (!article.updatedAt) return undefined;
  const published = new Date(article.publishedAt).valueOf();
  const updated = new Date(article.updatedAt).valueOf();
  return Number.isFinite(published) && Number.isFinite(updated) && updated > published
    ? article.updatedAt
    : undefined;
}

export function safeTimesExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function plainTimesArticleText(value: string, format: "html" | "text" = "text"): string {
  if (format === "text") return value;
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/gu, " ")
    .trim();
}
