import {
  JoxClient,
  ResourceCache,
  abortable,
  asJojoCatalog,
  asJojoBookSearchIndex,
  asJojoDatasetIndex,
  asJojoFragment,
  asJojoItemManifest,
  resolveJoxObject,
  type JojoCatalogEntry,
  type JojoBookSearchIndex,
  type JojoDatasetItemSummary,
  type JojoFragment,
  type JojoItemManifest,
  type JojoTocNode,
  type JojoContentAccess,
  bookFragmentAssetRefs,
} from "@jojo/content";
import { mobileContentCache } from "./contentCache";

export interface MobileBook {
  datasetId: string;
  title: string;
  indexObject: string;
  type: "book" | "book-series";
  itemCount?: number;
  aiEnabled?: boolean;
  access?: JojoContentAccess;
}

export interface MobileBookVolume {
  itemId: string;
  itemKey: string;
  title: string;
  order: number;
  manifestObject: string;
  access?: JojoContentAccess;
}

export type MobileBookOpenTarget =
  | { screen: "BookDetails"; book: MobileBook }
  | {
      screen: "BookReader";
      datasetId: string;
      itemKey: string;
      title: string;
      bookTitle: string;
    };

export interface LegacyBookResumeTarget {
  chapterId: string;
  chapterProgress: number;
}

export function resolveLegacyBookResume(
  chapters: readonly { id: string }[],
  progress: number,
): LegacyBookResumeTarget | undefined {
  if (!chapters.length || !Number.isFinite(progress) || progress <= 0) return undefined;
  const bookPosition = Math.max(0, Math.min(1, progress / 100)) * chapters.length;
  const chapterIndex = Math.min(chapters.length - 1, Math.floor(bookPosition));
  return {
    chapterId: chapters[chapterIndex]!.id,
    chapterProgress: Math.max(0, Math.min(1, bookPosition - chapterIndex)),
  };
}

export interface LoadedMobileBookItem {
  book: MobileBook;
  volume: MobileBookVolume;
  manifest: JojoItemManifest;
  manifestObject: string;
  contentClient?: JoxClient;
  offline?: boolean;
  ownerId?: string;
  access?: JojoContentAccess;
}

export interface LoadedMobileBookChapter {
  fragment: JojoFragment;
  assetUrls: Record<string, string>;
}

export interface MobileBookSearchResult {
  chapterId: string;
  chapterTitle: string;
  before: string;
  match: string;
  after: string;
  leadingEllipsis: boolean;
  trailingEllipsis: boolean;
}

export interface MobileAnnotationReference {
  volumeNumber: number;
  chapterTitle: string;
  annotationLabel: string;
}

export interface ResolvedMobileAnnotationReference {
  itemKey: string;
  itemTitle: string;
  chapterId: string;
  annotationId: string;
}

const CONTENT_CDN = process.env.EXPO_PUBLIC_CONTENT_CDN_BASE?.trim()
  || "https://blacknews.jojokanbao.cn/";
const contentStore = mobileContentCache();
const client = new JoxClient(CONTENT_CDN, (input, init) => fetch(input, init),
  new ResourceCache(contentStore, undefined, { staleWhileRevalidate: true }));
const coverCache = new ResourceCache(contentStore, undefined, { staleWhileRevalidate: true });
let catalogPromise: Promise<MobileBook[]> | undefined;
const volumePromises = new Map<string, Promise<MobileBookVolume[]>>();
const coverPromises = new Map<string, Promise<string | undefined>>();
const loadedCoverUris = new Map<string, string>();
const searchIndexPromises = new WeakMap<JoxClient, Map<string, Promise<JojoBookSearchIndex>>>();

export function fuzzyBookTitleScore(title: string, query: string): number {
  const normalize = (value: string) => value.toLocaleLowerCase()
    .replace(/[\s·—_《》〈〉，。！？、：；,.!?:;()（）【】\[\]-]/g, "");
  const normalizedTitle = normalize(title);
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return 0;
  const directIndex = normalizedTitle.indexOf(normalizedQuery);
  if (directIndex >= 0) return directIndex + (normalizedTitle.length - normalizedQuery.length) / 100;
  let titleIndex = 0;
  let gaps = 0;
  for (const character of normalizedQuery) {
    const foundAt = normalizedTitle.indexOf(character, titleIndex);
    if (foundAt < 0) return Number.POSITIVE_INFINITY;
    gaps += foundAt - titleIndex;
    titleIndex = foundAt + 1;
  }
  return 100 + gaps + (normalizedTitle.length - normalizedQuery.length) / 100;
}

export function selectPublishedBooks(entries: readonly JojoCatalogEntry[]): MobileBook[] {
  return entries
    .filter((entry): entry is JojoCatalogEntry & { type: MobileBook["type"] } => (
      (entry.type === "book" || entry.type === "book-series")
      && entry.publicationStatus !== "draft"
    ))
    .map((entry) => ({
      datasetId: entry.datasetId,
      title: entry.title,
      indexObject: entry.indexObject,
      type: entry.type,
      itemCount: entry.itemCount,
      aiEnabled: entry.aiEnabled,
      access: entry.access,
    }))
    .sort((left, right) => left.title.localeCompare(right.title, "zh-CN"));
}

export function selectPublishedBookVolumes(items: readonly JojoDatasetItemSummary[]): MobileBookVolume[] {
  return items
    .filter((item) => item.publicationStatus !== "draft")
    .map((item) => ({
      itemId: item.itemId,
      itemKey: item.itemKey,
      title: item.title,
      order: item.order,
      manifestObject: item.manifestObject,
      access: item.access,
    }))
    .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title, "zh-CN"));
}

export function loadMobileBooks(): Promise<MobileBook[]> {
  catalogPromise ??= client.fetchJson<unknown>("catalog.jox")
    .then(asJojoCatalog)
    .then((catalog) => selectPublishedBooks(catalog.datasets))
    .catch((error: unknown) => {
      catalogPromise = undefined;
      throw error;
    });
  return catalogPromise;
}

export function loadMobileBookVolumes(book: MobileBook): Promise<MobileBookVolume[]> {
  let promise = volumePromises.get(book.datasetId);
  if (!promise) {
    promise = client.fetchJson<unknown>(book.indexObject)
      .then(asJojoDatasetIndex)
      .then((index) => {
        if (index.datasetId !== book.datasetId) throw new Error("Dataset Index 格式无效");
        book.access = index.access ?? book.access;
        return selectPublishedBookVolumes(index.items);
      })
      .catch((error: unknown) => {
        volumePromises.delete(book.datasetId);
        throw error;
      });
    volumePromises.set(book.datasetId, promise);
  }
  return promise;
}

export async function resolveMobileBookOpenTarget(book: MobileBook): Promise<MobileBookOpenTarget> {
  const volumes = await loadMobileBookVolumes(book);
  const onlyVolume = volumes.length === 1 ? volumes[0] : undefined;
  return onlyVolume ? {
    screen: "BookReader",
    datasetId: book.datasetId,
    itemKey: onlyVolume.itemKey,
    title: onlyVolume.title,
    bookTitle: book.title,
  } : { screen: "BookDetails", book };
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

export function cachedMobileBookCover(book: MobileBook | string, itemKey?: string): string {
  return typeof book !== "string" && book.access === "authenticated" ? "" : loadedCoverUris.get(`${typeof book === "string" ? book : book.datasetId}:${itemKey ?? ""}`) ?? "";
}

export function loadMobileBookCover(source: MobileBook | string, itemKey?: string): Promise<string | undefined> {
  const datasetId = typeof source === "string" ? source : source.datasetId;
  const cacheKey = `${datasetId}:${itemKey ?? ""}`;
  const publicCacheKey = `jojo:book-cover:public:${cacheKey}`;
  let fallback: Uint8Array | undefined;
  let promise = coverPromises.get(cacheKey);
  if (!promise) {
    promise = (async () => {
      const cached = typeof source === "string" || source.access !== "authenticated"
        ? await contentStore?.get(publicCacheKey).catch(() => undefined) : undefined;
      fallback = cached?.bytes;
      if (cached && cached.expiresAt > Date.now()) {
        const uri = new TextDecoder().decode(cached.bytes) || undefined;
        if (uri) loadedCoverUris.set(cacheKey, uri);
        return uri;
      }
      const book = typeof source === "string" ? (await loadMobileBooks()).find((item) => item.datasetId === source) : source;
      if (!book) throw new Error("书籍目录暂时无法载入");
      const volumes = await loadMobileBookVolumes(book);
      const volume = itemKey ? volumes.find((candidate) => candidate.itemKey === itemKey || candidate.itemId === itemKey) : volumes[0];
      if (!volume) return undefined;
      const loaded = await loadMobileBookItem(datasetId, volume.itemKey);
      if (loaded.access === "authenticated") { book.access = "authenticated"; fallback = undefined; }
      const fetchCover = async () => {
        const cover = loaded.manifest.assets.find((asset) => asset.type === "image" && asset.role === "cover");
        if (!cover) return new Uint8Array();
        const object = resolveJoxObject(loaded.manifestObject, cover.object);
        const bytes = await (loaded.contentClient ?? client).fetchDecodedBytes(object, undefined, cover.sha256);
        return new TextEncoder().encode(`data:${cover.mediaType};base64,${bytesToBase64(bytes)}`);
      };
      // Keep public cover persistence and itemId aliases; restricted bytes never enter the shared cache.
      const restricted = loaded.access === "authenticated";
      const bytes = restricted ? await fetchCover() : await coverCache.get(publicCacheKey, 7 * 86400_000, fetchCover);
      const uri = new TextDecoder().decode(bytes) || undefined;
      if (restricted) { coverPromises.delete(cacheKey); loadedCoverUris.delete(cacheKey); }
      else if (uri) {
        loadedCoverUris.set(cacheKey, uri);
        for (const key of new Set([volume.itemKey, volume.itemId, itemKey ?? ""])) {
          void contentStore?.set(`jojo:book-cover:public:${datasetId}:${key}`, { bytes, expiresAt: Date.now() + 7 * 86400_000 }).catch(() => undefined);
        }
      }
      return uri;
    })().catch((error: unknown) => { coverPromises.delete(cacheKey); if (fallback) return new TextDecoder().decode(fallback) || undefined; throw error; });
    coverPromises.set(cacheKey, promise);
  }
  return promise;
}

export async function loadMobileBookItem(datasetId: string, itemKey: string, signal?: AbortSignal): Promise<LoadedMobileBookItem> {
  const offline = await import("../offline/books").then(({ openMobileOfflineBook }) => openMobileOfflineBook(datasetId, itemKey)).catch(() => undefined);
  if (signal?.aborted) throw new Error("读取已取消");
  if (offline) return {
    book: { datasetId, title: offline.entry.title, type: offline.entry.type as MobileBook["type"], indexObject: offline.entry.indexObject, access: offline.entry.access },
    volume: { itemId: offline.item.itemId, itemKey: offline.item.itemKey, title: offline.item.title, order: offline.item.order, manifestObject: offline.item.manifestObject, access: offline.item.access },
    manifest: offline.manifest, manifestObject: offline.manifestObject, contentClient: offline.client, offline: true,
    access: offline.scope === "public" ? "public" : "authenticated",
    ownerId: offline.scope.startsWith("user:") ? offline.scope.slice(5) : undefined,
  };
  const books = await abortable(loadMobileBooks(), signal);
  const book = books.find((candidate) => candidate.datasetId === datasetId);
  if (!book) throw new Error("书籍不存在");
  const volumes = await abortable(loadMobileBookVolumes(book), signal);
  const volume = volumes.find((candidate) => candidate.itemKey === itemKey || candidate.itemId === itemKey);
  if (!volume) throw new Error("分卷不存在");
  const manifestObject = resolveJoxObject(book.indexObject, volume.manifestObject);
  const manifest = asJojoItemManifest(
    await client.fetchJson<unknown>(manifestObject, signal),
  );
  if (manifest.datasetId !== datasetId || manifest.itemId !== volume.itemId) {
    throw new Error("书籍内容格式无效");
  }
  const access = manifest.access ?? volume.access ?? book.access ?? "public";
  const contentClient = access === "authenticated"
    ? (await import("../offline/books")).mobileAuthenticatedBookClient()
    : client;
  const ownerId = access === "authenticated" ? (await import("../offline/books")).mobileBookOwnerId() ?? undefined : undefined;
  return { book, volume, manifest, manifestObject, contentClient, access, ownerId };
}

export async function loadMobileBookChapter(
  loaded: LoadedMobileBookItem,
  chapterId: string,
  includeAssets = true,
  signal?: AbortSignal,
): Promise<LoadedMobileBookChapter> {
  if (loaded.access === "authenticated") (await import("../offline/books")).assertMobileBookOwner(loaded.ownerId, Boolean(loaded.offline));
  const chapter = loaded.manifest.content.chapters?.find((candidate) => candidate.id === chapterId);
  if (!chapter) throw new Error("章节不存在");
  const contentClient = loaded.contentClient ?? client;
  const originalFragment = asJojoFragment(await contentClient.fetchJson<unknown>(
    resolveJoxObject(loaded.manifestObject, chapter.object),
    signal, "default", chapter.sha256,
  ));
  const fragment = { ...originalFragment, assetRefs: bookFragmentAssetRefs(originalFragment) };
  if (fragment.itemId !== loaded.manifest.itemId || fragment.fragmentId !== chapter.id) {
    throw new Error("章节内容格式无效");
  }
  if (!includeAssets) return { fragment, assetUrls: {} };
  const assetPairs = await Promise.all(fragment.assetRefs.map(async (assetId) => {
    const asset = loaded.manifest.assets.find((candidate) => candidate.id === assetId);
    if (!asset) return undefined;
    try {
      const bytes = await contentClient.fetchDecodedBytes(resolveJoxObject(loaded.manifestObject, asset.object), signal, asset.sha256);
      return [assetId, `data:${asset.mediaType};base64,${bytesToBase64(bytes)}`] as const;
    } catch {
      return undefined;
    }
  }));
  const assetUrls: Record<string, string> = {};
  for (const pair of assetPairs) {
    if (pair) assetUrls[pair[0]] = pair[1];
  }
  return { fragment, assetUrls };
}

/** Warm only neighbouring chapters, not the whole book. Failures are retryable on demand. */
export async function prefetchMobileBookChapters(loaded: LoadedMobileBookItem, chapterId: string, signal: AbortSignal) {
  const chapters = loaded.manifest.content.chapters ?? [];
  const index = chapters.findIndex((chapter) => chapter.id === chapterId);
  if (index < 0) return;
  for (const chapter of [chapters[index + 1], chapters[index - 1]]) {
    if (signal.aborted) return;
    if (chapter) await loadMobileBookChapter(loaded, chapter.id, true, signal).catch(() => undefined);
  }
}

function flattenToc(nodes: readonly JojoTocNode[] = []): JojoTocNode[] {
  return nodes.flatMap((node) => [node, ...flattenToc(node.children)]);
}

function numberedAnnotationIds(fragment: JojoFragment): string[] {
  if (fragment.body.format !== "html") return [];
  const withoutHeadingMarkers = fragment.body.value.replace(
    /<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]\s*>/gi,
    (heading) => heading.replace(/<sup\b[^>]*data-annotation-id[^>]*>[\s\S]*?<\/sup\s*>/gi, ""),
  );
  return [...withoutHeadingMarkers.matchAll(/<sup\b[^>]*data-annotation-id\s*=\s*(["'])([^"']+)\1/gi)]
    .map((match) => match[2]!)
    .filter(Boolean);
}

export async function resolveMobileAnnotationReference(
  loaded: LoadedMobileBookItem,
  reference: MobileAnnotationReference,
): Promise<ResolvedMobileAnnotationReference> {
  const volumes = await loadMobileBookVolumes(loaded.book);
  const volume = volumes.find((candidate) => (
    candidate.itemKey === `volume-${reference.volumeNumber}` || candidate.order === reference.volumeNumber
  ));
  if (!volume) throw new Error(`找不到第${reference.volumeNumber}卷`);
  const target = await loadMobileBookItem(loaded.book.datasetId, volume.itemKey);
  const normalizedTitle = reference.chapterTitle.normalize("NFKC").trim();
  const tocTarget = flattenToc(target.manifest.content.toc).find((node) => (
    node.title.normalize("NFKC").trim() === normalizedTitle
  ));
  const chapter = target.manifest.content.chapters?.find((candidate) => (
    candidate.id === tocTarget?.targetId || candidate.title.normalize("NFKC").trim() === normalizedTitle
  ));
  if (!chapter) throw new Error(`找不到《${reference.chapterTitle}》`);
  const loadedChapter = await loadMobileBookChapter(target, chapter.id);
  const numberedId = /^\d+$/.test(reference.annotationLabel)
    ? numberedAnnotationIds(loadedChapter.fragment)[Number(reference.annotationLabel) - 1]
    : undefined;
  const annotation = (numberedId
    ? loadedChapter.fragment.annotations.find((candidate) => candidate.id === numberedId)
    : undefined)
    ?? loadedChapter.fragment.annotations.find((candidate) => candidate.label === reference.annotationLabel);
  if (!annotation) throw new Error(`《${reference.chapterTitle}》没有注〔${reference.annotationLabel}〕`);
  return { itemKey: volume.itemKey, itemTitle: volume.title, chapterId: chapter.id, annotationId: annotation.id };
}

function searchableText(fragment: JojoFragment): string {
  if (fragment.body.format === "text") return fragment.body.value;
  return fragment.body.value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function normalizedSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

export function createMobileBookSearchResult(
  chapterId: string,
  chapterTitle: string,
  source: string,
  query: string,
): MobileBookSearchResult | undefined {
  const text = source.replace(/\s+/g, " ").trim();
  const needle = normalizedSearchText(query);
  const normalized = normalizedSearchText(text);
  const normalizedIndex = normalized.indexOf(needle);
  if (normalizedIndex < 0) return undefined;
  const directIndex = text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  const matchIndex = directIndex >= 0 ? directIndex : Math.min(normalizedIndex, text.length);
  const matchLength = directIndex >= 0
    ? query.trim().length
    : Math.max(1, Math.min(needle.length, text.length - matchIndex));
  const excerptStart = Math.max(0, matchIndex - 54);
  const excerptEnd = Math.min(text.length, matchIndex + matchLength + 82);
  return {
    chapterId,
    chapterTitle,
    before: text.slice(excerptStart, matchIndex),
    match: text.slice(matchIndex, matchIndex + matchLength),
    after: text.slice(matchIndex + matchLength, excerptEnd),
    leadingEllipsis: excerptStart > 0,
    trailingEllipsis: excerptEnd < text.length,
  };
}

async function loadMobileBookSearchIndex(loaded: LoadedMobileBookItem): Promise<JojoBookSearchIndex | undefined> {
  const descriptor = loaded.manifest.search;
  if (!descriptor) return undefined;
  const object = resolveJoxObject(loaded.manifestObject, descriptor.object);
  const contentClient = loaded.contentClient ?? client;
  let promises = searchIndexPromises.get(contentClient);
  if (!promises) { promises = new Map(); searchIndexPromises.set(contentClient, promises); }
  const key = `${loaded.manifest.itemId}\0${object}\0${descriptor.sha256}`;
  let promise = promises.get(key);
  if (!promise) {
    promise = contentClient.fetchJson<unknown>(object, undefined, "default", descriptor.sha256).then(asJojoBookSearchIndex)
      .catch((error: unknown) => { if (promises!.get(key) === promise) promises!.delete(key); throw error; });
    promises.set(key, promise);
  }
  const index = await promise;
  if (index.itemId !== loaded.manifest.itemId) throw new Error("书内搜索文件与当前书籍不匹配");
  return index;
}

export async function searchMobileBook(
  loaded: LoadedMobileBookItem,
  query: string,
  size = 30,
): Promise<MobileBookSearchResult[]> {
  if (loaded.access === "authenticated") (await import("../offline/books")).assertMobileBookOwner(loaded.ownerId, Boolean(loaded.offline));
  if (!normalizedSearchText(query)) return [];
  const chapterTitles = new Map(
    (loaded.manifest.content.chapters ?? []).map((candidate) => [candidate.id, candidate.title]),
  );
  const staticIndex = await loadMobileBookSearchIndex(loaded);
  if (staticIndex) {
    const results: MobileBookSearchResult[] = [];
    for (const block of staticIndex.blocks) {
      const result = createMobileBookSearchResult(
        block.targetId,
        chapterTitles.get(block.targetId) ?? "正文",
        block.text,
        query,
      );
      if (result) results.push(result);
      if (results.length >= size) break;
    }
    return results;
  }

  const chapters = loaded.manifest.content.chapters ?? [];
  const results: MobileBookSearchResult[] = [];
  for (let start = 0; start < chapters.length; start += 8) {
    const batch = chapters.slice(start, start + 8);
    const fragments = await Promise.all(batch.map((candidate) => loadMobileBookChapter(loaded, candidate.id)));
    for (const loadedChapter of fragments) {
      const result = createMobileBookSearchResult(
        loadedChapter.fragment.fragmentId,
        loadedChapter.fragment.title,
        searchableText(loadedChapter.fragment),
        query,
      );
      if (result) results.push(result);
      if (results.length >= size) return results;
    }
  }
  return results;
}
