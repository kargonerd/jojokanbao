import {
  JoxClient,
  resolveJoxObject,
  type JojoFragment,
  type TimesDateManifest,
  type TimesDeliveryArticle,
  type TimesDeliveryIndex,
  type TimesSourceHealth,
  type TimesUnavailableCase,
} from "@jojo/content";

const TIMES_CDN = import.meta.env.VITE_TIMES_CDN_BASE
  || import.meta.env.VITE_CONTENT_CDN_BASE
  || "https://blacknews.jojokanbao.cn/";
const TIMES_INDEX_OBJECT = "content/newspapers/times/index.jox";
const client = new JoxClient(TIMES_CDN, (input, init) => fetch(input, init));

export type TimesNewsItem = TimesDeliveryArticle & {
  content?: string | null;
  contentFormat?: "html" | "text";
};

export interface TimesOverview {
  updatedAt: string;
  window: TimesDeliveryIndex["window"];
  articles: TimesNewsItem[];
  sourceHealth: TimesSourceHealth[];
  unavailableCases: TimesUnavailableCase[];
}

function asTimesIndex(value: TimesDeliveryIndex): TimesDeliveryIndex {
  if (value.formatVersion !== "jojo-delivery-index/1" || value.datasetId !== "times" || !Array.isArray(value.items)) {
    throw new Error("时事 CDN index 格式无效");
  }
  if (!value.window || !Array.isArray(value.sourceHealth) || !Array.isArray(value.unavailableCases)) {
    throw new Error("时事 CDN 缺少健康审计数据");
  }
  return value;
}

function asDateManifest(value: TimesDateManifest): TimesDateManifest {
  if (value.formatVersion !== "jojo-item-manifest/1" || value.datasetId !== "times") {
    throw new Error("时事日期 manifest 格式无效");
  }
  if (value.metadata?.formatVersion !== "jojo-times-date-metadata/1" || !Array.isArray(value.metadata.articles)) {
    throw new Error("时事日期 manifest 缺少文章索引");
  }
  return value;
}

function safeArticleObject(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized.startsWith("content/newspapers/times/items/") || normalized.includes("../")) {
    throw new Error("时事文章对象路径无效");
  }
  return normalized;
}

let overviewPromise: Promise<TimesOverview> | undefined;

async function loadOverview(): Promise<TimesOverview> {
  const index = asTimesIndex(await client.fetchJson<TimesDeliveryIndex>(TIMES_INDEX_OBJECT, undefined, "no-store"));
  const fromDate = index.window.from.slice(0, 10);
  const relevantItems = index.items.filter((item) => item.itemKey >= fromDate);
  const manifests = await Promise.all(relevantItems.map(async (item) => {
    const object = resolveJoxObject(TIMES_INDEX_OBJECT, item.manifestObject);
    return asDateManifest(await client.fetchJson<TimesDateManifest>(object, undefined, "no-store"));
  }));
  const from = Date.parse(index.window.from);
  const to = Date.parse(index.window.to);
  const articles = manifests.flatMap((manifest) => manifest.metadata.articles)
    .filter((article) => {
      const time = Date.parse(article.publishedAt);
      return Number.isFinite(time) && time >= from && time <= to;
    })
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
  return {
    updatedAt: index.updatedAt,
    window: index.window,
    articles,
    sourceHealth: index.sourceHealth,
    unavailableCases: index.unavailableCases,
  };
}

async function overview(refresh = false): Promise<TimesOverview> {
  if (refresh || !overviewPromise) overviewPromise = loadOverview();
  try {
    return await overviewPromise;
  } catch (error) {
    overviewPromise = undefined;
    throw error;
  }
}

export const timesApi = {
  overview,

  invalidate() {
    overviewPromise = undefined;
  },

  async listNews(): Promise<TimesNewsItem[]> {
    return (await overview()).articles;
  },

  async getNews(newsId: string): Promise<TimesNewsItem> {
    const item = (await overview()).articles.find((candidate) => candidate.id === newsId);
    if (!item) throw new Error("新闻不存在或已超出过去一天窗口");
    const fragment = await client.fetchJson<JojoFragment>(safeArticleObject(item.articleObject));
    if (fragment.formatVersion !== "jojo-fragment/1" || fragment.type !== "article" || fragment.fragmentId !== item.id) {
      throw new Error("时事文章对象格式无效");
    }
    return { ...item, content: fragment.body.value, contentFormat: fragment.body.format };
  },
};
