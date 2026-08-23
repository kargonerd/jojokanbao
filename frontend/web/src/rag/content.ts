import {
  JoxClient,
  resolveJoxObject,
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
  if (!entry) throw new Error("Dataset 不存在");
  const sources = datasetSources.get(datasetId) ?? [{ entry, client }];
  const loadedIndexes = await Promise.all(sources.map(async (source) => ({
    source,
    index: asJojoDatasetIndex(await source.client.fetchJson<JojoDatasetIndex>(source.entry.indexObject)),
  })));
  if (loadedIndexes.some(({ index }) => index.datasetId !== datasetId)) throw new Error("Dataset Index 格式无效");
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
  if (!item) throw new Error("Item 不存在");
  const itemClient = dataset.itemClients.get(item.itemId) ?? dataset.client;
  const manifestObject = resolveJoxObject(dataset.entry.indexObject, item.manifestObject);
  const manifest = asJojoItemManifest(await itemClient.fetchJson<JojoItemManifest>(manifestObject));
  if (manifest.itemId !== item.itemId) throw new Error("Item Manifest 格式无效");
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

export async function loadBookCoverUrl(datasetId: string, itemKey?: string): Promise<string | undefined> {
  const dataset = await loadDataset(datasetId);
  const summary = itemKey
    ? dataset.index.items.find((item) => item.itemKey === itemKey || item.itemId === itemKey)
    : dataset.index.items.find((item) => item.publicationStatus !== "draft");
  if (!summary) return undefined;
  const loaded = await loadItem(datasetId, summary.itemKey);
  const cover = loaded.manifest.assets.find((asset) => asset.type === "image" && asset.role === "cover");
  return cover ? loadAssetUrl(loaded, cover.id) : undefined;
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

function normalizedSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function searchIndexResults(
  loaded: LoadedItem,
  index: JojoBookSearchIndex,
  query: string,
  size: number,
): RagSearchHit[] {
  const needle = normalizedSearchText(query);
  const chapterTitles = new Map(
    (loaded.manifest.content.chapters ?? []).map((chapter) => [chapter.id, chapter.title]),
  );
  const results: RagSearchHit[] = [];
  for (const block of index.blocks) {
    const text = block.text.replace(/\s+/g, " ").trim();
    const normalized = normalizedSearchText(text);
    const normalizedIndex = normalized.indexOf(needle);
    if (normalizedIndex < 0) continue;

    // NFKC normally preserves offsets for Chinese prose. If it does not, use
    // the original query offset; otherwise keep a readable result without
    // inventing a location that is not present in the chapter.
    const directIndex = text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
    const matchIndex = directIndex >= 0 ? directIndex : Math.min(normalizedIndex, text.length);
    const matchLength = directIndex >= 0 ? query.trim().length : Math.min(needle.length, text.length - matchIndex);
    const excerptStart = Math.max(0, matchIndex - 70);
    const excerptEnd = Math.min(text.length, matchIndex + matchLength + 120);
    const before = text.slice(excerptStart, matchIndex);
    const match = text.slice(matchIndex, matchIndex + matchLength);
    const after = text.slice(matchIndex + matchLength, excerptEnd);
    const title = chapterTitles.get(block.targetId) ?? "正文";
    results.push({
      datasetId: loaded.manifest.datasetId,
      itemId: loaded.manifest.itemId,
      targetId: block.targetId,
      targetTitle: title,
      title,
      text: `${excerptStart > 0 ? "…" : ""}${text.slice(excerptStart, excerptEnd)}${excerptEnd < text.length ? "…" : ""}`,
      highlights: [`${excerptStart > 0 ? "…" : ""}${escapeHighlight(before)}<mark>${escapeHighlight(match)}</mark>${escapeHighlight(after)}${excerptEnd < text.length ? "…" : ""}`],
    });
    if (results.length >= size) break;
  }
  return results;
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
  const needle = normalizedSearchText(query);
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
      const index = normalizedSearchText(text).indexOf(needle);
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
