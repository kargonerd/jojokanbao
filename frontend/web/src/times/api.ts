import {
  JoxClient,
  NEWS_TIMELINE_PROFILE,
  resolveJoxObject,
  type JojoCatalog,
  type JojoCatalogEntry,
  type JojoFragment,
  type NewsDateManifest,
  type NewsDeliveryArticle,
  type NewsPublisherIndex,
} from "@jojo/content";

const CONTENT_CDN = import.meta.env.VITE_CONTENT_CDN_BASE || "https://blacknews.jojokanbao.cn/";
const CATALOG_OBJECT = "catalog.jox";
const client = new JoxClient(CONTENT_CDN, (input, init) => fetch(input, init));

export type TimesNewsItem = NewsDeliveryArticle & {
  content?: string | null;
  contentFormat?: "html" | "text";
};

export interface TimesPublisher {
  id: string;
  name: string;
  language: string;
  indexObject: string;
  dates: string[];
}

export interface TimesDirectory {
  updatedAt: string;
  publishers: TimesPublisher[];
  dates: string[];
}

export interface TimesTimelineDay {
  date: string;
  articles: TimesNewsItem[];
}

interface PublisherState {
  entry: JojoCatalogEntry;
  index: NewsPublisherIndex;
}

function asCatalog(value: JojoCatalog): JojoCatalog {
  if (value.formatVersion !== "jojo-catalog/1" || !Array.isArray(value.datasets)) {
    throw new Error("新闻目录格式无效");
  }
  return value;
}

function asPublisherIndex(value: NewsPublisherIndex, entry: JojoCatalogEntry): NewsPublisherIndex {
  if (
    value.formatVersion !== "jojo-delivery-index/1"
    || value.type !== "newspaper"
    || value.datasetId !== entry.datasetId
    || value.contentProfile !== NEWS_TIMELINE_PROFILE
    || !Array.isArray(value.items)
  ) throw new Error(`${entry.title}新闻索引格式无效`);
  return value;
}

function asDateManifest(value: NewsDateManifest, sourceId: string, date: string): NewsDateManifest {
  if (
    value.formatVersion !== "jojo-item-manifest/1"
    || value.type !== "newspaper"
    || value.datasetId !== sourceId
    || value.metadata?.formatVersion !== "jojo-news-date-metadata/1"
    || value.metadata.issueDate !== date
    || value.metadata.source?.id !== sourceId
    || !Array.isArray(value.metadata.articles)
  ) throw new Error(`${sourceId} ${date} 新闻清单格式无效`);
  return value;
}

function safeSegment(value: string, label: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(value)) throw new Error(`${label}无效`);
  return value;
}

function safeDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error("新闻日期无效");
  }
  return value;
}

function safeArticleObject(value: string, sourceId: string, date: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  const [year, month] = safeDate(date).split("-");
  const prefix = `content/newspapers/${safeSegment(sourceId, "媒体")}/items/${year}/${month}/${date}/articles/`;
  if (!normalized.startsWith(prefix) || normalized.includes("../") || !normalized.endsWith(".jox")) {
    throw new Error("新闻正文对象路径无效");
  }
  return normalized;
}

let directoryPromise: Promise<{ directory: TimesDirectory; states: PublisherState[] }> | undefined;
const manifestPromises = new Map<string, Promise<NewsDateManifest>>();

async function loadDirectory(): Promise<{ directory: TimesDirectory; states: PublisherState[] }> {
  const catalog = asCatalog(await client.fetchJson<JojoCatalog>(CATALOG_OBJECT, undefined, "no-store"));
  const entries = catalog.datasets.filter((entry) => (
    entry.type === "newspaper" && entry.contentProfile === NEWS_TIMELINE_PROFILE
  ));
  const states = await Promise.all(entries.map(async (entry) => ({
    entry,
    index: asPublisherIndex(
      await client.fetchJson<NewsPublisherIndex>(entry.indexObject, undefined, "no-store"),
      entry,
    ),
  })));
  const dates = [...new Set(states.flatMap(({ index }) => index.items.map((item) => item.itemKey)))].sort().reverse();
  const updatedAt = states.reduce(
    (latest, { index }) => index.updatedAt > latest ? index.updatedAt : latest,
    catalog.updatedAt,
  );
  return {
    states,
    directory: {
      updatedAt,
      dates,
      publishers: states.map(({ entry, index }) => ({
        id: entry.datasetId,
        name: entry.title,
        language: entry.language,
        indexObject: entry.indexObject,
        dates: index.items.map((item) => item.itemKey),
      })),
    },
  };
}

async function directoryState(refresh = false) {
  if (refresh || !directoryPromise) directoryPromise = loadDirectory();
  try {
    return await directoryPromise;
  } catch (error) {
    directoryPromise = undefined;
    throw error;
  }
}

async function loadManifest(state: PublisherState, date: string): Promise<NewsDateManifest | null> {
  const item = state.index.items.find((candidate) => candidate.itemKey === date);
  if (!item) return null;
  const object = resolveJoxObject(state.entry.indexObject, item.manifestObject);
  let promise = manifestPromises.get(object);
  if (!promise) {
    promise = client.fetchJson<NewsDateManifest>(object, undefined, "no-store")
      .then((value) => asDateManifest(value, state.entry.datasetId, date));
    manifestPromises.set(object, promise);
  }
  try {
    return await promise;
  } catch (error) {
    manifestPromises.delete(object);
    throw error;
  }
}

export const timesApi = {
  async directory(refresh = false): Promise<TimesDirectory> {
    return (await directoryState(refresh)).directory;
  },

  invalidate() {
    directoryPromise = undefined;
    manifestPromises.clear();
  },

  async loadDate(value: string): Promise<TimesTimelineDay> {
    const date = safeDate(value);
    const { states } = await directoryState();
    const relevantStates = states.filter((state) => state.index.items.some((item) => item.itemKey === date));
    const results = await Promise.allSettled(relevantStates.map((state) => loadManifest(state, date)));
    const manifests = results.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
    if (relevantStates.length > 0 && manifests.length === 0) {
      throw new Error(`${date} 的新闻暂时无法加载`);
    }
    const articles = manifests
      .flatMap((manifest) => manifest.metadata.articles)
      .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
    return { date, articles };
  },

  async listNews(): Promise<TimesNewsItem[]> {
    const directory = await this.directory();
    if (!directory.dates[0]) return [];
    return (await this.loadDate(directory.dates[0])).articles;
  },

  async getNews(sourceValue: string, dateValue: string, newsId: string): Promise<TimesNewsItem> {
    const sourceId = safeSegment(sourceValue, "媒体");
    const date = safeDate(dateValue);
    const { states } = await directoryState();
    const state = states.find(({ entry }) => entry.datasetId === sourceId);
    if (!state) throw new Error("媒体不存在");
    const manifest = await loadManifest(state, date);
    const item = manifest?.metadata.articles.find((candidate) => candidate.id === newsId);
    if (!item) throw new Error("新闻不存在");
    const articleObject = safeArticleObject(item.articleObject, sourceId, date);
    const fragment = await client.fetchJson<JojoFragment>(articleObject);
    if (
      fragment.formatVersion !== "jojo-fragment/1"
      || fragment.type !== "article"
      || fragment.fragmentId !== item.id
      || fragment.itemId !== `${sourceId}:${date}`
    ) throw new Error("新闻正文格式无效");
    return { ...item, content: fragment.body.value, contentFormat: fragment.body.format };
  },
};
