import {
  JoxClient,
  resolveJoxObject,
  searchJojoBookIndex,
  asJojoBookSearchIndex,
  asJojoCatalog,
  asJojoDatasetIndex,
  asJojoItemManifest,
  type JojoCatalog,
  type JojoBookSearchIndex,
  type JojoCatalogEntry,
  type JojoDatasetIndex,
  type JojoDatasetItemSummary,
  type JojoFragment,
  type JojoItemManifest,
} from "@jojo/content";
import type { RagSearchHit } from "./types";

const CONTENT_CDN = import.meta.env.VITE_CONTENT_CDN_BASE || "https://blacknews.jojokanbao.cn/";
const client = new JoxClient(CONTENT_CDN);
const fallbackClient = import.meta.env.VITE_CONTENT_CDN_FALLBACK_BASE
  ? new JoxClient(import.meta.env.VITE_CONTENT_CDN_FALLBACK_BASE)
  : undefined;
let catalogPromise: Promise<JojoCatalog> | undefined;
const datasetSources = new Map<string, Array<{ entry: JojoCatalogEntry; client: JoxClient }>>();
const bookSearchPromises = new Map<string, Promise<JojoBookSearchIndex>>();
const bookCoverPromises = new Map<string, Promise<string | undefined>>();
type LoadedDatasetIndex = JojoDatasetIndex & { items: JojoDatasetItemSummary[] };

export interface LoadedDataset {
  entry: JojoCatalogEntry;
  index: LoadedDatasetIndex;
  client: JoxClient;
  itemClients: Map<string, JoxClient>;
}

export interface LoadedItem extends LoadedDataset {
  item: JojoDatasetItemSummary;
  manifest: JojoItemManifest;
  manifestObject: string;
}

export function loadCatalog(): Promise<JojoCatalog> {
  catalogPromise ??= (async () => {
    const primary = asJojoCatalog(await client.fetchJson<JojoCatalog>("catalog.jox", undefined, "no-store"));
    const fallback = fallbackClient
      ? await fallbackClient.fetchJson<JojoCatalog>("catalog.jox", undefined, "no-store").then(asJojoCatalog).catch(() => undefined)
      : undefined;
    const entries = new Map<string, JojoCatalogEntry>();
    datasetSources.clear();
    for (const source of [
      ...(fallback && fallbackClient ? [{ catalog: fallback, client: fallbackClient }] : []),
      { catalog: primary, client },
    ]) {
      for (const entry of source.catalog.datasets) {
        entries.set(entry.datasetId, entry);
        const existing = datasetSources.get(entry.datasetId) ?? [];
        datasetSources.set(entry.datasetId, [{ entry, client: source.client }, ...existing]);
      }
    }
    return {
      formatVersion: "jojo-catalog/1",
      revision: Math.max(primary.revision, fallback?.revision ?? 0),
      updatedAt: primary.updatedAt,
      datasets: [...entries.values()].sort((left, right) => left.title.localeCompare(right.title, "zh-CN")),
    };
  })();
  return catalogPromise;
}

export async function loadDataset(datasetId: string): Promise<LoadedDataset> {
  const catalog = await loadCatalog();
  const entry = catalog.datasets.find((candidate) => candidate.datasetId === datasetId);
  if (!entry) throw new Error("找不到对应的书目");
  const sources = datasetSources.get(datasetId) ?? [{ entry, client }];
  const loadedIndexes = await Promise.all(sources.map(async (source) => ({
    source,
    index: asJojoDatasetIndex(await source.client.fetchJson<JojoDatasetIndex>(source.entry.indexObject)),
  })));
  if (loadedIndexes.some(({ index }) => index.datasetId !== datasetId)) throw new Error("书目暂时无法读取");
  const itemClients = new Map<string, JoxClient>();
  const items = new Map<string, JojoDatasetItemSummary>();
  for (const { source, index } of [...loadedIndexes].reverse()) {
    for (const item of index.items) {
      items.set(item.itemId, item);
      itemClients.set(item.itemId, source.client);
    }
  }
  const primary = loadedIndexes[0]!;
  const index: LoadedDatasetIndex = {
    ...primary.index,
    revision: Math.max(...loadedIndexes.map((value) => value.index.revision)),
    type: items.size > 1 && primary.index.type === "book" ? "book-series" : primary.index.type,
    items: [...items.values()].sort((left, right) => left.order - right.order || left.title.localeCompare(right.title, "zh-CN")),
  };
  return { entry, index, client: primary.source.client, itemClients };
}

export async function loadItem(datasetId: string, itemKey: string): Promise<LoadedItem> {
  const dataset = await loadDataset(datasetId);
  const item = dataset.index.items.find((candidate) => candidate.itemKey === itemKey || candidate.itemId === itemKey);
  if (!item) throw new Error("找不到对应的书籍");
  const itemClient = dataset.itemClients.get(item.itemId) ?? dataset.client;
  const manifestObject = resolveJoxObject(dataset.entry.indexObject, item.manifestObject);
  const manifest = asJojoItemManifest(
    await itemClient.fetchJson<JojoItemManifest>(manifestObject, undefined, "no-store"),
  );
  if (manifest.itemId !== item.itemId) throw new Error("书籍暂时无法读取");
  return { ...dataset, client: itemClient, item, manifest, manifestObject };
}

export async function loadFragment(loaded: LoadedItem, chapterId: string): Promise<JojoFragment> {
  const chapter = loaded.manifest.content.chapters?.find((candidate) => candidate.id === chapterId);
  if (!chapter) throw new Error("章节不存在");
  return loaded.client.fetchJson<JojoFragment>(resolveJoxObject(loaded.manifestObject, chapter.object));
}

export async function loadAssetUrl(loaded: LoadedItem, assetId: string): Promise<string> {
  const asset = loaded.manifest.assets.find((candidate) => candidate.id === assetId);
  if (!asset) throw new Error(`资源不存在：${assetId}`);
  const bytes = await loaded.client.fetchDecodedBytes(resolveJoxObject(loaded.manifestObject, asset.object));
  return URL.createObjectURL(new Blob([bytes.slice().buffer], { type: asset.mediaType }));
}

export function loadBookCoverUrl(datasetId: string, itemKey?: string): Promise<string | undefined> {
  const cacheKey = `${datasetId}:${itemKey ?? ""}`;
  const cached = bookCoverPromises.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    const dataset = await loadDataset(datasetId);
    const summary = itemKey
      ? dataset.index.items.find((item) => item.itemKey === itemKey || item.itemId === itemKey)
      : dataset.index.items.find((item) => item.publicationStatus !== "draft");
    if (!summary) return undefined;
    const itemClient = dataset.itemClients.get(summary.itemId) ?? dataset.client;
    const manifestObject = resolveJoxObject(dataset.entry.indexObject, summary.manifestObject);
    const manifest = asJojoItemManifest(
      await itemClient.fetchJson<JojoItemManifest>(manifestObject, undefined, "no-store"),
    );
    const cover = manifest.assets.find((asset) => asset.type === "image" && asset.role === "cover");
    if (!cover) return undefined;
    const bytes = await itemClient.fetchDecodedBytes(resolveJoxObject(manifestObject, cover.object));
    return URL.createObjectURL(new Blob([bytes.slice().buffer], { type: cover.mediaType }));
  })().catch((error: unknown) => {
    bookCoverPromises.delete(cacheKey);
    throw error;
  });
  bookCoverPromises.set(cacheKey, promise);
  return promise;
}

export async function downloadExport(loaded: LoadedItem, exportId: string): Promise<void> {
  const descriptor = loaded.manifest.exports.find((candidate) => candidate.id === exportId);
  if (!descriptor) throw new Error("导出文件不存在");
  const bytes = await loaded.client.fetchDecodedBytes(resolveJoxObject(loaded.manifestObject, descriptor.object));
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: descriptor.mediaType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = descriptor.fileName;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function searchableText(fragment: JojoFragment): string {
  if (fragment.body.format === "text") return fragment.body.value;
  return new DOMParser().parseFromString(fragment.body.value, "text/html").body.textContent || "";
}

function escapeHighlight(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function searchIndexResults(
  loaded: LoadedItem,
  index: JojoBookSearchIndex,
  query: string,
  size: number,
): RagSearchHit[] {
  const chapterTitles = new Map(
    (loaded.manifest.content.chapters ?? []).map((chapter) => [chapter.id, chapter.title]),
  );
  return searchJojoBookIndex(index, query, { limit: size }).map((match) => {
    const title = chapterTitles.get(match.targetId) ?? "正文";
    const escapedExcerpt = escapeHighlight(match.excerpt);
    const escapedMatch = escapeHighlight(match.matchText);
    return {
      datasetId: loaded.manifest.datasetId,
      itemId: loaded.manifest.itemId,
      targetId: match.targetId,
      targetTitle: title,
      title,
      text: match.excerpt,
      highlights: [escapedExcerpt.replace(escapedMatch, `<mark>${escapedMatch}</mark>`)],
    };
  });
}

async function loadBookSearchIndex(loaded: LoadedItem): Promise<JojoBookSearchIndex | undefined> {
  const descriptor = loaded.manifest.search;
  if (!descriptor) return undefined;
  const object = resolveJoxObject(loaded.manifestObject, descriptor.object);
  const key = `${loaded.manifest.itemId}\0${object}\0${descriptor.sha256}`;
  let promise = bookSearchPromises.get(key);
  if (!promise) {
    promise = loaded.client.fetchJson<JojoBookSearchIndex>(object).then(asJojoBookSearchIndex);
    bookSearchPromises.set(key, promise);
  }
  const index = await promise;
  if (index.itemId !== loaded.manifest.itemId) throw new Error("书内搜索文件与当前书籍不匹配");
  return index;
}

export async function searchLoadedBook(loaded: LoadedItem, query: string, size = 30): Promise<RagSearchHit[]> {
  const needle = query.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
  if (!needle) return [];
  const staticIndex = await loadBookSearchIndex(loaded);
  if (staticIndex) return searchIndexResults(loaded, staticIndex, query, size);
  const chapters = loaded.manifest.content.chapters ?? [];
  const results: RagSearchHit[] = [];
  for (let start = 0; start < chapters.length; start += 8) {
    const batch = chapters.slice(start, start + 8);
    const fragments = await Promise.all(batch.map((chapter) => loadFragment(loaded, chapter.id)));
    for (const fragment of fragments) {
      const text = searchableText(fragment).replace(/\s+/g, " ").trim();
      const index = text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim().indexOf(needle);
      if (index < 0) continue;
      const excerptStart = Math.max(0, index - 70);
      const excerptEnd = Math.min(text.length, index + query.length + 120);
      const before = text.slice(excerptStart, index);
      const match = text.slice(index, index + query.length);
      const after = text.slice(index + query.length, excerptEnd);
      results.push({
        datasetId: loaded.manifest.datasetId,
        itemId: loaded.manifest.itemId,
        targetId: fragment.fragmentId,
        targetTitle: fragment.title,
        title: fragment.title,
        text: `${excerptStart > 0 ? "…" : ""}${text.slice(excerptStart, excerptEnd)}${excerptEnd < text.length ? "…" : ""}`,
        highlights: [`${excerptStart > 0 ? "…" : ""}${escapeHighlight(before)}<mark>${escapeHighlight(match)}</mark>${escapeHighlight(after)}${excerptEnd < text.length ? "…" : ""}`],
      });
      if (results.length >= size) return results;
    }
  }
  return results;
}
