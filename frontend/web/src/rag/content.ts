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
  bookFragmentAssetRefs,
} from "@jojo/content";
import type { RagSearchHit } from "./types";
import { useAccountSessionStore } from "../account/session";
import { browserOfflineBookIdentity } from "../offline/identity";

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
  offline?: boolean;
  ownerId?: string;
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
  const offline = await import("../offline/books").then(({ openOfflineBook }) => openOfflineBook(datasetId, itemKey)).catch(() => undefined);
  if (offline) return { entry: offline.entry, index: offline.index, item: offline.item, manifest: offline.manifest, manifestObject: offline.manifestObject, client: offline.client, offline: true, ownerId: offline.scope.startsWith("user:") ? offline.scope.slice(5) : undefined };
  const dataset = await loadDataset(datasetId);
  const item = dataset.index.items.find((candidate) => candidate.itemKey === itemKey || candidate.itemId === itemKey);
  if (!item) throw new Error("找不到对应的书籍");
  const manifestObject = resolveJoxObject(dataset.entry.indexObject, item.manifestObject);
  const manifest = asJojoItemManifest(
    await dataset.client.fetchJson<JojoItemManifest>(manifestObject),
  );
  if (manifest.itemId !== item.itemId) throw new Error("书籍暂时无法读取");
  const access = manifest.access ?? item.access ?? dataset.index.access ?? dataset.entry.access ?? "public";
  const ownerId = access === "authenticated" ? useAccountSessionStore.getState().userId ?? undefined : undefined;
  const itemClient = access === "authenticated" ? new JoxClient(CONTENT_CDN, async (input, init) => {
    if (!ownerId || useAccountSessionStore.getState().userId !== ownerId) throw new Error("请先登录，再阅读这本书");
    const response = await fetch(input, { ...init, cache: "no-store" });
    if (useAccountSessionStore.getState().userId !== ownerId) throw new Error("登录状态已改变，请重新打开书籍");
    return response;
  }) : dataset.client;
  return { ...dataset, client: itemClient, item, manifest, manifestObject, ownerId };
}

function assertLoadedAccess(loaded: LoadedItem) {
  const access = loaded.manifest.access ?? loaded.item.access ?? loaded.index.access ?? loaded.entry.access ?? "public";
  const userId = loaded.offline ? browserOfflineBookIdentity().userId : useAccountSessionStore.getState().userId;
  if (access === "authenticated" && (!loaded.ownerId || loaded.ownerId !== userId)) throw new Error("请先登录，再阅读这本书");
}

export async function loadFragment(loaded: LoadedItem, chapterId: string, signal?: AbortSignal): Promise<JojoFragment> {
  assertLoadedAccess(loaded);
  const chapter = loaded.manifest.content.chapters?.find((candidate) => candidate.id === chapterId);
  if (!chapter) throw new Error("章节不存在");
  const fragment = asJojoFragment(await loaded.client.fetchJson<JojoFragment>(resolveJoxObject(loaded.manifestObject, chapter.object), signal, "default", chapter.sha256));
  if (fragment.itemId !== loaded.manifest.itemId || fragment.fragmentId !== chapter.id) throw new Error("章节内容不匹配");
  return { ...fragment, assetRefs: bookFragmentAssetRefs(fragment) };
}

export async function loadAssetUrl(loaded: LoadedItem, assetId: string, signal?: AbortSignal): Promise<string> {
  assertLoadedAccess(loaded);
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
  const cacheKey = `${useAccountSessionStore.getState().userId ?? "public"}:${datasetId}:${itemKey ?? ""}`;
  const cached = bookCoverPromises.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    let key = itemKey;
    if (!key) {
      const dataset = await loadDataset(datasetId);
      key = dataset.index.items.find((item) => item.publicationStatus !== "draft")?.itemKey;
    }
    if (!key) return undefined;
    const loaded = await loadItem(datasetId, key);
    const cover = loaded.manifest.assets.find((asset) => asset.type === "image" && asset.role === "cover");
    return cover ? loadAssetUrl(loaded, cover.id) : undefined;
  })().catch((error: unknown) => {
    bookCoverPromises.delete(cacheKey);
    throw error;
  });
  bookCoverPromises.set(cacheKey, promise);
  return promise;
}

export async function downloadExport(loaded: LoadedItem, exportId: string): Promise<void> {
  assertLoadedAccess(loaded);
  const descriptor = loaded.manifest.exports.find((candidate) => candidate.id === exportId);
  if (!descriptor) throw new Error("导出文件不存在");
  // A full-book export can be much larger than an interactive chapter or cover.
  let exportClient = loaded.client;
  if (loaded.offline) {
    const access = loaded.manifest.access ?? loaded.item.access ?? loaded.index.access ?? loaded.entry.access ?? "public";
    const owner = useAccountSessionStore.getState().userId;
    if (access === "authenticated" && (!owner || owner !== loaded.ownerId)) throw new Error("请联网登录后下载 EPUB，已保存的正文仍可离线阅读");
    exportClient = new JoxClient(CONTENT_CDN, async (input, init) => {
      if (access === "authenticated" && useAccountSessionStore.getState().userId !== owner) throw new Error("登录状态已改变，请重新下载");
      const response = await fetch(input, { ...init, cache: "no-store" });
      if (access === "authenticated" && useAccountSessionStore.getState().userId !== owner) throw new Error("登录状态已改变，请重新下载");
      return response;
    });
  }
  const bytes = await exportClient.fetchDecodedBytes(resolveJoxObject(loaded.manifestObject, descriptor.object), undefined, descriptor.sha256, 120_000);
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
  const key = `${loaded.ownerId ?? "public"}\0${loaded.offline ? "offline" : "online"}\0${loaded.manifest.itemId}\0${object}\0${descriptor.sha256}`;
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
  assertLoadedAccess(loaded);
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
