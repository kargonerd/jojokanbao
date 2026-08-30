import {
  JoxClient,
  resolveJoxObject,
  type JojoAssetDescriptor,
  type JojoFragment,
  type TimesTimelineDay,
  type TimesTimelineIndex,
} from "@jojo/content";
import {
  preferredTimesTranslation,
  presentTimesArticle,
  type TimesForeignContentLanguage,
  type TimesPresentedArticle,
} from "./language";

const CONTENT_CDN = import.meta.env.VITE_CONTENT_CDN_BASE || "https://blacknews.jojokanbao.cn/";
const TIMELINE_INDEX_OBJECT = "content/timeline/index.jox";
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
  if (refresh || !dayPromises.has(date)) {
    const object = resolveJoxObject(TIMELINE_INDEX_OBJECT, ref.object);
    dayPromises.set(date, client.fetchJson<TimesTimelineDay>(object, undefined, "no-store").then((value) => asTimelineDay(value, date)));
  }
  try {
    return await dayPromises.get(date)!;
  } catch (error) {
    dayPromises.delete(date);
    throw error;
  }
}

export const timesApi = {
  timelineIndex,
  timelineDay,
  assetObjectUrl,
  assetObjectBlob,

  invalidate() {
    indexPromise = undefined;
    dayPromises.clear();
  },

  async getNews(
    issueDate: string,
    newsId: string,
    languagePreference: TimesForeignContentLanguage = "zh-CN",
  ): Promise<TimesNewsItem> {
    const item = (await timelineDay(issueDate)).articles.find((candidate) => candidate.id === newsId);
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
