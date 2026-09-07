import {
  JoxClient,
  ResourceCache,
  browserContentCache,
  asJojoFragment,
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
const client = new JoxClient(CONTENT_CDN, fetch, new ResourceCache(browserContentCache()));
let catalogPromise: Promise<JojoCatalog> | undefined;
const bookSearchPromises = new Map<string, Promise<JojoBookSearchIndex>>();
const bookCoverPromises = new Map<string, Promise<string | undefined>>();
type LoadedDatasetIndex = JojoDatasetIndex & { items: JojoDatasetItemSummary[] };

export interface LoadedDataset {
  entry: JojoCatalogEntry;
  index: LoadedDatasetIndex;
  client: JoxClient;
}

export interface LoadedItem extends LoadedDataset {
  item: JojoDatasetItemSummary;
  manifest: JojoItemManifest;
  manifestObject: string;
}

export function loadCatalog(): Promise<JojoCatalog> {
  catalogPromise ??= client.fetchJson<JojoCatalog>("catalog.jox", undefined, "no-store")
    .then(asJojoCatalog)
    .catch((error: unknown) => {
      catalogPromise = undefined;
      throw error;
    });
  return catalogPromise;
}

export async function loadDataset(datasetId: string): Promise<LoadedDataset> {
  const catalog = await loadCatalog();
  const entry = catalog.datasets.find((candidate) => candidate.datasetId === datasetId);
  if (!entry) throw new Error("找不到对应的书目");
  const index = asJojoDatasetIndex(await client.fetchJson<JojoDatasetIndex>(entry.indexObject));
  if (index.datasetId !== datasetId) throw new Error("书目暂时无法读取");
  return { entry, index, client };
}

export async function loadItem(datasetId: string, itemKey: string): Promise<LoadedItem> {
  const dataset = await loadDataset(datasetId);
  const item = dataset.index.items.find((candidate) => candidate.itemKey === itemKey || candidate.itemId === itemKey);
  if (!item) throw new Error("找不到对应的书籍");
  const manifestObject = resolveJoxObject(dataset.entry.indexObject, item.manifestObject);
  const manifest = asJojoItemManifest(
    await dataset.client.fetchJson<JojoItemManifest>(manifestObject),
  );
  if (manifest.itemId !== item.itemId) throw new Error("书籍暂时无法读取");
  return { ...dataset, item, manifest, manifestObject };
}

export async function loadFragment(loaded: LoadedItem, chapterId: string, signal?: AbortSignal): Promise<JojoFragment> {
  const chapter = loaded.manifest.content.chapters?.find((candidate) => candidate.id === chapterId);
  if (!chapter) throw new Error("章节不存在");
  const fragment = asJojoFragment(await loaded.client.fetchJson<JojoFragment>(resolveJoxObject(loaded.manifestObject, chapter.object), signal, "default", chapter.sha256));
  if (fragment.itemId !== loaded.manifest.itemId || fragment.fragmentId !== chapter.id) throw new Error("章节内容不匹配");
  return fragment;
}

export async function loadAssetUrl(loaded: LoadedItem, assetId: string, signal?: AbortSignal): Promise<string> {
  const asset = loaded.manifest.assets.find((candidate) => candidate.id === assetId);
  if (!asset) throw new Error(`资源不存在：${assetId}`);
  const bytes = await loaded.client.fetchDecodedBytes(resolveJoxObject(loaded.manifestObject, asset.object), signal, asset.sha256);
  return URL.createObjectURL(new Blob([bytes.slice().buffer], { type: asset.mediaType }));
}

export async function prefetchBookChapters(loaded: LoadedItem, chapterId: string, signal: AbortSignal) {
  const chapters = loaded.manifest.content.chapters ?? [];
  const index = chapters.findIndex((chapter) => chapter.id === chapterId);
  if (index < 0) return;
  for (const chapter of [chapters[index + 1], chapters[index - 1]]) {
    if (signal.aborted) return;
    if (!chapter) continue;
    try {
      const fragment = await loadFragment(loaded, chapter.id, signal);
      for (const id of fragment.assetRefs) {
        if (signal.aborted) return;
        const asset = loaded.manifest.assets.find((item) => item.id === id);
        if (asset) await loaded.client.fetchBytes(resolveJoxObject(loaded.manifestObject, asset.object), signal, "default", asset.sha256).catch(() => undefined);
      }
    } catch { /* A failed prefetch never blocks the current chapter or a later retry. */ }
  }
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
    const manifestObject = resolveJoxObject(dataset.entry.indexObject, summary.manifestObject);
    const manifest = asJojoItemManifest(
      await dataset.client.fetchJson<JojoItemManifest>(manifestObject),
    );
    const cover = manifest.assets.find((asset) => asset.type === "image" && asset.role === "cover");
    if (!cover) return undefined;
    const bytes = await dataset.client.fetchDecodedBytes(resolveJoxObject(manifestObject, cover.object), undefined, cover.sha256);
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
  // A full-book export can be much larger than an interactive chapter or cover.
  const bytes = await loaded.client.fetchDecodedBytes(resolveJoxObject(loaded.manifestObject, descriptor.object), undefined, descriptor.sha256, 120_000);
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
    promise = loaded.client.fetchJson<JojoBookSearchIndex>(object, undefined, "default", descriptor.sha256).then(asJojoBookSearchIndex)
      .catch((error: unknown) => { if (bookSearchPromises.get(key) === promise) bookSearchPromises.delete(key); throw error; });
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
