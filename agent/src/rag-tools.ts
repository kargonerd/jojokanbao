import {
  JoxClient,
  asJojoBookSearchIndex,
  asJojoCatalog,
  asJojoDatasetIndex,
  asJojoFragment,
  asJojoItemManifest,
  gunzipJoxJson,
  resolveJoxObject,
  searchJojoBookIndex,
  supportsJojoDatasetAi,
  type JojoBookSearchIndex,
  type JojoCatalog,
  type JojoCatalogEntry,
  type JojoDatasetIndex,
  type JojoDatasetItemSummary,
  type JojoFragment,
  type JojoItemManifest,
  type JojoTocNode,
} from "@jojo/content";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { addCitationIds } from "./citations";

export interface RagScope {
  mode?: "all" | "selected";
  datasetIds?: string[];
  itemIds?: string[];
  manifestObjects?: string[];
}

export interface RagToolOptions {
  contentCdnBase: string;
  scope?: RagScope;
  fetchFn?: typeof fetch;
  fullItemByteBudget?: number;
  searchIndexByteBudget?: number;
}

interface LoadedDataset {
  entry: JojoCatalogEntry;
  index: JojoDatasetIndex & { items: JojoDatasetItemSummary[] };
  indexObject: string;
}

function safeObjectKey(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized.startsWith("content/") || !normalized.endsWith(".jox") || normalized.includes("../")) {
    throw new Error("非法 Jox 对象路径");
  }
  return normalized;
}

function enforceDatasetObjectScope(objectKey: string, scope: RagScope): void {
  const categories = ["books", "newspapers", "magazines"];
  if (scope.datasetIds?.length && !scope.datasetIds.some((datasetId) => (
    categories.some((category) => objectKey.startsWith(`content/${category}/${datasetId}/`))
  ))) {
    throw new Error("该对象不在用户选择的 Dataset 范围内");
  }
}

function textBody(fragment: JojoFragment): string {
  if (fragment.body.format === "text") return fragment.body.value;
  return fragment.body.value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/h[1-6]>|<\/li>|<\/blockquote>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function result(value: unknown) {
  const enriched = addCitationIds(value);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(enriched, null, 2) }],
    details: enriched,
  };
}

function occurrences(text: string, terms: string[]): number {
  return terms.reduce((total, term) => {
    if (!term) return total;
    let offset = 0;
    let count = 0;
    while ((offset = text.indexOf(term, offset)) >= 0) {
      count += 1;
      offset += Math.max(1, term.length);
    }
    return total + count;
  }, 0);
}

function excerpt(text: string, terms: string[], maxChars: number): string {
  const positions = terms.map((term) => text.indexOf(term)).filter((position) => position >= 0);
  const center = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, center - Math.floor(maxChars * .3));
  return `${start > 0 ? "…" : ""}${text.slice(start, start + maxChars)}${start + maxChars < text.length ? "…" : ""}`;
}

interface AgentTocEntry {
  id: string;
  order: number;
  depth: number;
  title: string;
  targetId?: string;
  anchorId?: string;
  fragmentObject?: string;
}

function itemToc(manifest: JojoItemManifest, manifestObject: string): AgentTocEntry[] {
  const chapters = manifest.content.chapters ?? [];
  const chapterObjects = new Map(chapters.map((chapter) => [
    chapter.id,
    resolveJoxObject(manifestObject, chapter.object),
  ]));
  const flatten = (nodes: JojoTocNode[], depth = 0): AgentTocEntry[] => nodes.flatMap((node) => [{
    id: node.id,
    order: node.order,
    depth,
    title: node.title,
    ...(node.targetId ? { targetId: node.targetId } : {}),
    ...(node.anchorId ? { anchorId: node.anchorId } : {}),
    ...(node.targetId && chapterObjects.has(node.targetId)
      ? { fragmentObject: chapterObjects.get(node.targetId) }
      : {}),
  }, ...flatten(node.children ?? [], depth + 1)]);
  const toc = flatten(manifest.content.toc ?? []);
  return toc.length ? toc : chapters.map((chapter) => ({
    id: `toc:${chapter.id}`,
    order: chapter.order,
    depth: 0,
    title: chapter.title,
    targetId: chapter.id,
    fragmentObject: chapterObjects.get(chapter.id),
  }));
}

export function createRagTools(options: RagToolOptions): AgentTool[] {
  const fetchFn = options.fetchFn ?? fetch;
  const jox = new JoxClient(options.contentCdnBase, fetchFn);
  const scope = options.scope ?? {};
  let catalogPromise: Promise<JojoCatalog> | undefined;
  const datasetCache = new Map<string, Promise<LoadedDataset>>();
  const manifestCache = new Map<string, JojoItemManifest>();
  const bookSearchCache = new Map<string, JojoBookSearchIndex>();
  const inspectedManifests = new Set<string>();
  const fullItemByteBudget = options.fullItemByteBudget ?? 32 * 1024 * 1024;
  const searchIndexByteBudget = options.searchIndexByteBudget ?? 16 * 1024 * 1024;
  let residentSearchIndexBytes = 0;

  function allowedCatalogEntry(entry: JojoCatalogEntry): boolean {
    return supportsJojoDatasetAi(entry)
      && (entry.type === "book" || entry.type === "book-series")
      && entry.publicationStatus !== "draft"
      && (!scope.datasetIds?.length || scope.datasetIds.includes(entry.datasetId));
  }

  async function loadCatalog(signal?: AbortSignal): Promise<JojoCatalog> {
    catalogPromise ??= jox.fetchJson<JojoCatalog>("catalog.jox", signal, "no-store")
      .then(asJojoCatalog);
    return catalogPromise;
  }

  async function loadDataset(datasetId: string, signal?: AbortSignal): Promise<LoadedDataset> {
    let promise = datasetCache.get(datasetId);
    if (!promise) {
      promise = (async () => {
        const catalog = await loadCatalog(signal);
        const entry = catalog.datasets.find((candidate) => candidate.datasetId === datasetId);
        if (!entry || !allowedCatalogEntry(entry)) {
          throw new Error("该 Dataset 不支持馆藏问答或不在用户选择范围内");
        }
        const indexObject = safeObjectKey(entry.indexObject);
        const index = asJojoDatasetIndex(
          await jox.fetchJson<JojoDatasetIndex>(indexObject, signal),
        );
        if (index.datasetId !== entry.datasetId) {
          throw new Error("Dataset Index 与馆藏目录不匹配");
        }
        return { entry, index, indexObject };
      })();
      datasetCache.set(datasetId, promise);
    }
    return promise;
  }

  function enforceManifestScope(manifest: JojoItemManifest): void {
    if (scope.datasetIds?.length && !scope.datasetIds.includes(manifest.datasetId)) {
      throw new Error("该 Dataset 不在用户选择范围内");
    }
    if (scope.itemIds?.length && !scope.itemIds.includes(manifest.itemId)) {
      throw new Error("该 Item 不在用户选择范围内");
    }
  }

  function resolveManifestObject(candidate: string | undefined): string {
    const selected = scope.manifestObjects ?? [];
    const object = safeObjectKey(candidate || (selected.length === 1 ? selected[0]! : ""));
    if (selected.length && !selected.includes(object)) {
      throw new Error("该 Manifest 不在用户选择范围内");
    }
    enforceDatasetObjectScope(object, scope);
    return object;
  }

  async function loadManifest(object: string, signal?: AbortSignal): Promise<JojoItemManifest> {
    const cached = manifestCache.get(object);
    if (cached) return cached;
    const manifest = asJojoItemManifest(
      await jox.fetchJson<JojoItemManifest>(object, signal, "no-store"),
    );
    enforceManifestScope(manifest);
    manifestCache.set(object, manifest);
    return manifest;
  }

  function itemManifestObject(
    dataset: LoadedDataset,
    item: JojoDatasetItemSummary,
  ): string {
    return safeObjectKey(resolveJoxObject(dataset.indexObject, item.manifestObject));
  }

  function uniqueStrings(values: string[] | undefined, limit = 100): string[] {
    return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))]
      .slice(0, limit);
  }

  async function candidateDatasetIds(
    requested: string[] | undefined,
    signal?: AbortSignal,
  ): Promise<{ ids: string[]; needsSelection?: boolean }> {
    const explicit = uniqueStrings(requested, 9);
    const fallback = scope.datasetIds?.length === 1 ? scope.datasetIds : [];
    const ids = explicit.length ? explicit : fallback;
    if (!ids.length) return { ids: [], needsSelection: true };
    if (ids.length > 8) return { ids, needsSelection: true };
    const allowed = new Set(
      (await loadCatalog(signal)).datasets.filter(allowedCatalogEntry)
        .map((entry) => entry.datasetId),
    );
    const invalid = ids.filter((id) => !allowed.has(id));
    if (invalid.length) {
      throw new Error(`这些 Dataset 不支持馆藏问答或超出选择范围：${invalid.join("、")}`);
    }
    return { ids };
  }

  function datasetIdFromObject(object: string): string | undefined {
    return object.match(/^content\/(?:books|newspapers|magazines)\/([^/]+)\//)?.[1];
  }

  const listLibraryParameters = Type.Object({
    titleQuery: Type.Optional(Type.String({ description: "可选的书名关键词；不传则列出全部可用书籍" })),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  });
  const listLibraryTool: AgentTool<typeof listLibraryParameters> = {
    name: "list_library_books",
    label: "查看可问答书籍",
    description: "读取很小的馆藏目录，只列出支持 AI 的书籍，不下载正文。默认全馆提问时先据此挑选最可能相关的多本候选书。",
    parameters: listLibraryParameters,
    async execute(_callId, args, signal) {
      const catalog = await loadCatalog(signal);
      const needle = args.titleQuery?.normalize("NFKC").toLocaleLowerCase().trim();
      const limit = Math.max(1, Math.min(100, Math.floor(args.limit ?? 100)));
      const books = catalog.datasets.filter(allowedCatalogEntry)
        .filter((entry) => !needle || entry.title.normalize("NFKC").toLocaleLowerCase().includes(needle))
        .slice(0, limit)
        .map((entry) => ({
          datasetId: entry.datasetId,
          title: entry.title,
          type: entry.type,
          itemCount: entry.itemCount,
        }));
      return result({
        total: books.length,
        books,
        scopeMode: scope.mode ?? (scope.datasetIds?.length ? "selected" : "all"),
        advice: "从书名挑选最多 8 个候选 datasetId，再调用 list_book_items 或 search_content。",
      });
    },
  };

  const listBookItemsParameters = Type.Object({
    datasetIds: Type.Optional(Type.Array(Type.String(), { maxItems: 8 })),
  });
  const listBookItemsTool: AgentTool<typeof listBookItemsParameters> = {
    name: "list_book_items",
    label: "查看书籍分卷",
    description: "读取候选书的小型 Dataset Index，列出各册/各卷和 manifestObject，不下载目录或正文。",
    parameters: listBookItemsParameters,
    async execute(_callId, args, signal) {
      const candidates = await candidateDatasetIds(args.datasetIds, signal);
      if (candidates.needsSelection) {
        return result({
          needsSelection: true,
          advice: "请先用 list_library_books 选择最多 8 本候选书，再传入 datasetIds。",
        });
      }
      const datasets = await Promise.all(
        candidates.ids.map((datasetId) => loadDataset(datasetId, signal)),
      );
      return result({
        datasets: datasets.map((dataset) => ({
          datasetId: dataset.entry.datasetId,
          title: dataset.entry.title,
          items: dataset.index.items
            .filter((item) => item.publicationStatus !== "draft")
            .map((item) => ({
              itemId: item.itemId,
              itemKey: item.itemKey,
              title: item.title,
              manifestObject: itemManifestObject(dataset, item),
            })),
        })),
        advice: "可把相关 itemId 交给 search_content；没有静态索引时，再用 manifestObject 查看目录并按章读取。",
      });
    },
  };

  const selectedSearchParameters = Type.Object({
    query: Type.String({ description: "要在当前书内精确查找的关键词或短语" }),
    size: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
    manifestObject: Type.Optional(Type.String({ description: "当前已选书籍的 manifestObject；只选中一本时可省略" })),
  });
  const selectedSearchTool: AgentTool<typeof selectedSearchParameters> = {
    name: "search_selected_item",
    label: "搜索当前书籍",
    description: "把当前书随书发布的轻量静态索引下载到本次问答内存中精确检索。请使用原文中可能出现的关键词或短语。",
    parameters: selectedSearchParameters,
    async execute(_callId, args, signal) {
      const manifestObject = resolveManifestObject(args.manifestObject);
      const manifest = await loadManifest(manifestObject, signal);
      if (!manifest.search) {
        return result({
          available: false,
          total: 0,
          hits: [],
          advice: "当前书籍还没有静态索引，请调用 list_item_toc，根据目录只读取最相关的几个章节。",
        });
      }
      const indexObject = resolveJoxObject(manifestObject, manifest.search.object);
      let index = bookSearchCache.get(indexObject);
      if (!index) {
        if (residentSearchIndexBytes + manifest.search.size > searchIndexByteBudget) {
          return result({
            available: false,
            total: 0,
            hits: [],
            reason: "本次运行的静态索引内存预算不足",
            searchIndexSize: manifest.search.size,
            residentSearchIndexBytes,
            searchIndexByteBudget,
            advice: "请根据目录只读取最相关的几个章节。",
          });
        }
        index = asJojoBookSearchIndex(
          await jox.fetchJson<JojoBookSearchIndex>(indexObject, signal),
        );
        if (index.itemId !== manifest.itemId) {
          throw new Error("书内搜索文件与当前书籍不匹配");
        }
        bookSearchCache.set(indexObject, index);
        residentSearchIndexBytes += manifest.search.size;
      }
      const chapters = new Map(
        (manifest.content.chapters ?? []).map((chapter) => [chapter.id, chapter]),
      );
      const size = Math.max(1, Math.min(20, Math.floor(args.size ?? 8)));
      const hits = searchJojoBookIndex(index, args.query, {
        limit: size,
        before: 180,
        after: 420,
      }).map((match) => {
        const chapter = chapters.get(match.targetId);
        return {
          datasetId: manifest.datasetId,
          itemId: manifest.itemId,
          itemTitle: manifest.title,
          targetId: match.targetId,
          ...(match.anchorId ? { anchorId: match.anchorId } : {}),
          targetTitle: chapter?.title ?? "正文",
          title: chapter?.title ?? "正文",
          text: match.excerpt,
          manifestObject,
          ...(chapter
            ? { fragmentObject: resolveJoxObject(manifestObject, chapter.object) }
            : {}),
        };
      });
      return result({
        available: true,
        strategy: "static-book-index-memory",
        total: hits.length,
        hits,
        ...(hits.length
          ? {}
          : { advice: "没有精确命中。换用更接近原文的短关键词重试，或查看目录后只读取相关章节。" }),
      });
    },
  };

  const searchParameters = Type.Object({
    query: Type.String({ description: "最可能出现在原文中的关键词或短语；不要直接传整句问题" }),
    alternateQueries: Type.Optional(Type.Array(Type.String(), {
      maxItems: 5,
      description: "最多 5 个同义或相关的原文关键词，用于提高精确检索召回率",
    })),
    size: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
    datasetIds: Type.Optional(Type.Array(Type.String(), { maxItems: 8 })),
    itemIds: Type.Optional(Type.Array(Type.String(), { maxItems: 16 })),
  });
  const searchTool: AgentTool<typeof searchParameters> = {
    name: "search_content",
    label: "搜索候选书籍",
    description: "把候选书随书发布的 search.jox 下载到本次问答内存中检索，不使用 Elasticsearch，也不下载正文。先用书名挑选最多 8 本候选书；结果给出可继续读取的章节路径。",
    parameters: searchParameters,
    async execute(_callId, args, signal) {
      const candidates = await candidateDatasetIds(args.datasetIds, signal);
      if (candidates.needsSelection) {
        return result({
          needsSelection: true,
          total: 0,
          hits: [],
          advice: "默认全馆范围较大。请先调用 list_library_books，从书名选出最多 8 本候选书，再传入 datasetIds。",
        });
      }

      const requestedItemIds = new Set(uniqueStrings(args.itemIds, 16));
      const scopedItemIds = new Set(scope.itemIds ?? []);
      const datasets = await Promise.all(
        candidates.ids.map((datasetId) => loadDataset(datasetId, signal)),
      );
      const targets = datasets.flatMap((dataset) => dataset.index.items
        .filter((item) => item.publicationStatus !== "draft")
        .filter((item) => !requestedItemIds.size || requestedItemIds.has(item.itemId))
        .filter((item) => !scopedItemIds.size || scopedItemIds.has(item.itemId))
        .map((item) => ({
          dataset,
          item,
          manifestObject: itemManifestObject(dataset, item),
        })));
      if (targets.length > 16) {
        return result({
          needsSelection: true,
          total: 0,
          hits: [],
          candidateItemCount: targets.length,
          advice: "候选分卷超过 16 个。请先调用 list_book_items，再把最多 16 个相关 itemId 传给 search_content。",
        });
      }

      const queries = uniqueStrings([args.query, ...(args.alternateQueries ?? [])], 6);
      if (!queries.length) throw new Error("至少需要一个原文关键词");
      const size = Math.max(1, Math.min(20, Math.floor(args.size ?? 8)));
      const hits: Array<{
        datasetId: string;
        datasetTitle: string;
        itemId: string;
        itemTitle: string;
        targetId: string;
        anchorId?: string;
        targetTitle: string;
        text: string;
        matchedQuery: string;
        manifestObject: string;
        fragmentObject?: string;
      }> = [];
      const unindexedItems: Array<{
        datasetId: string;
        datasetTitle: string;
        itemId: string;
        itemTitle: string;
        manifestObject: string;
        reason: string;
      }> = [];
      const skippedItems: Array<{ itemId: string; title: string; reason: string }> = [];
      const seen = new Set<string>();
      let loadedSearchBytes = 0;
      let searchedItemCount = 0;

      for (const target of targets) {
        const manifest = await loadManifest(target.manifestObject, signal);
        if (!manifest.search) {
          unindexedItems.push({
            datasetId: target.dataset.entry.datasetId,
            datasetTitle: target.dataset.entry.title,
            itemId: target.item.itemId,
            itemTitle: target.item.title,
            manifestObject: target.manifestObject,
            reason: "书籍未提供静态正文索引",
          });
          continue;
        }
        const indexObject = resolveJoxObject(target.manifestObject, manifest.search.object);
        let index = bookSearchCache.get(indexObject);
        if (!index && residentSearchIndexBytes + manifest.search.size > searchIndexByteBudget) {
          skippedItems.push({
            itemId: target.item.itemId,
            title: target.item.title,
            reason: "本次运行的静态索引内存预算不足",
          });
          continue;
        }
        if (!index) {
          index = asJojoBookSearchIndex(
            await jox.fetchJson<JojoBookSearchIndex>(indexObject, signal),
          );
          if (index.itemId !== manifest.itemId) {
            throw new Error("书内搜索文件与当前书籍不匹配");
          }
          bookSearchCache.set(indexObject, index);
          loadedSearchBytes += manifest.search.size;
          residentSearchIndexBytes += manifest.search.size;
        }
        searchedItemCount += 1;
        const chapters = new Map(
          (manifest.content.chapters ?? []).map((chapter) => [chapter.id, chapter]),
        );
        for (const query of queries) {
          for (const match of searchJojoBookIndex(index, query, {
            limit: size,
            before: 180,
            after: 420,
          })) {
            const key = `${manifest.itemId}\0${match.targetId}\0${match.anchorId ?? ""}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const chapter = chapters.get(match.targetId);
            hits.push({
              datasetId: manifest.datasetId,
              datasetTitle: target.dataset.entry.title,
              itemId: manifest.itemId,
              itemTitle: manifest.title,
              targetId: match.targetId,
              ...(match.anchorId ? { anchorId: match.anchorId } : {}),
              targetTitle: chapter?.title ?? "正文",
              text: match.excerpt,
              matchedQuery: query,
              manifestObject: target.manifestObject,
              ...(chapter
                ? { fragmentObject: resolveJoxObject(target.manifestObject, chapter.object) }
                : {}),
            });
            if (hits.length >= size) break;
          }
          if (hits.length >= size) break;
        }
        if (hits.length >= size) break;
      }

      return result({
        strategy: "candidate-static-index-memory",
        queries,
        total: hits.length,
        hits,
        searchedItemCount,
        loadedSearchBytes,
        residentSearchIndexBytes,
        searchIndexByteBudget,
        unindexedItems,
        skippedItems,
        ...(!hits.length
          ? { advice: unindexedItems.length
            ? "候选书缺少静态索引。请对最相关的 manifestObject 调用 list_item_toc，再只读取目录中最相关的几个章节。"
            : "没有精确命中。请换用更接近原文的短关键词重试，或查看候选书目录后按章读取。" }
          : {}),
      });
    },
  };

  const fragmentParameters = Type.Object({
    fragmentObject: Type.String({ description: "search_content 返回的 fragmentObject" }),
    maxChars: Type.Optional(Type.Number({ minimum: 500, maximum: 20000 })),
  });
  const fragmentTool: AgentTool<typeof fragmentParameters> = {
    name: "read_fragment",
    label: "读取章节或文章",
    description: "从 CDN 读取一个搜索命中的完整章节或文章。普通问题优先使用本工具，不必扫描整本。",
    parameters: fragmentParameters,
    async execute(_callId, args, signal) {
      const object = safeObjectKey(args.fragmentObject);
      enforceDatasetObjectScope(object, scope);
      const fragment = asJojoFragment(await jox.fetchJson<JojoFragment>(object, signal));
      if (scope.itemIds?.length && !scope.itemIds.includes(fragment.itemId)) throw new Error("该 Item 不在用户选择范围内");
      const text = textBody(fragment);
      const maxChars = Math.max(500, Math.min(20_000, Math.floor(args.maxChars ?? 12_000)));
      return result({
        datasetId: scope.datasetIds?.length === 1
          ? scope.datasetIds[0]
          : datasetIdFromObject(object),
        itemId: fragment.itemId,
        targetId: fragment.fragmentId,
        title: fragment.title,
        text: text.slice(0, maxChars),
        truncated: text.length > maxChars,
        annotations: fragment.annotations,
        source: { fragmentObject: object },
      });
    },
  };

  const inspectParameters = Type.Object({
    manifestObject: Type.Optional(Type.String({ description: "search_content 返回的 manifestObject；当前已选中一本书时可省略" })),
  });
  const inspectTool: AgentTool<typeof inspectParameters> = {
    name: "inspect_item",
    label: "查看书籍概况",
    description: "读取小型 manifest，返回书籍规模、预算和目录预览，不下载正文。需要选择具体章节时继续调用 list_item_toc；考虑扫描全本时必须先调用本工具。",
    parameters: inspectParameters,
    async execute(_callId, args, signal) {
      const manifestObject = resolveManifestObject(args.manifestObject);
      const manifest = await loadManifest(manifestObject, signal);
      const chapters = manifest.content.chapters ?? [];
      const estimatedBytes = chapters.reduce((total, chapter) => total + chapter.size, 0);
      const toc = itemToc(manifest, manifestObject);
      inspectedManifests.add(manifestObject);
      return result({
        itemId: manifest.itemId,
        datasetId: manifest.datasetId,
        title: manifest.title,
        type: manifest.type,
        chapterCount: chapters.length,
        characterCount: manifest.contentStats.characterCount,
        estimatedProcessingBytes: estimatedBytes,
        fullScanByteBudget: fullItemByteBudget,
        withinFullScanBudget: estimatedBytes <= fullItemByteBudget,
        tocEntryCount: toc.length,
        tocPreview: toc.slice(0, 20),
        tocPreviewTruncated: toc.length > 20,
        ...(toc.length > 20 ? { nextTocOffset: 20 } : {}),
        source: { manifestObject },
      });
    },
  };

  const tocParameters = Type.Object({
    manifestObject: Type.Optional(Type.String({ description: "search_content 返回的 manifestObject；当前已选中一本书时可省略" })),
    offset: Type.Optional(Type.Number({ minimum: 0, description: "从第几个目录项开始，默认 0" })),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200, description: "本次返回数量，默认 100" })),
  });
  const tocTool: AgentTool<typeof tocParameters> = {
    name: "list_item_toc",
    label: "查看书籍目录",
    description: "分页查看一本书或一卷的完整层级目录。每个可读目录项包含 fragmentObject，可直接交给 read_fragment 读取正文；只读取 manifest，不下载正文。",
    parameters: tocParameters,
    async execute(_callId, args, signal) {
      const manifestObject = resolveManifestObject(args.manifestObject);
      const manifest = await loadManifest(manifestObject, signal);
      const toc = itemToc(manifest, manifestObject);
      const offset = Math.max(0, Math.floor(args.offset ?? 0));
      const limit = Math.max(1, Math.min(200, Math.floor(args.limit ?? 100)));
      const entries = toc.slice(offset, offset + limit);
      return result({
        itemId: manifest.itemId,
        datasetId: manifest.datasetId,
        title: manifest.title,
        total: toc.length,
        offset,
        limit,
        entries,
        hasMore: offset + entries.length < toc.length,
        ...(offset + entries.length < toc.length ? { nextOffset: offset + entries.length } : {}),
        source: { manifestObject },
      });
    },
  };

  const itemParameters = Type.Object({
    manifestObject: Type.Optional(Type.String({ description: "search_content 返回的 manifestObject；当前已选中一本书时可省略" })),
    intent: Type.String({ description: "为什么必须扫描整本，例如跨章比较、全书统计或全书综述" }),
    terms: Type.Array(Type.String(), { description: "用于本地扫描和计数的关键词，至少一个" }),
    maxEvidenceChapters: Type.Optional(Type.Number({ minimum: 1, maximum: 12 })),
  });
  const itemTool: AgentTool<typeof itemParameters> = {
    name: "scan_full_item",
    label: "按需扫描整本",
    description: "仅在搜索和单章阅读不足时调用。下载整个 Item 到工具侧，在本地扫描所有章节，只把统计和最相关证据送回模型，不把整本全文塞进上下文。",
    parameters: itemParameters,
    async execute(_callId, args, signal) {
      const manifestObject = resolveManifestObject(args.manifestObject);
      if (!inspectedManifests.has(manifestObject)) {
        return result({
          scanned: false,
          reason: "item must be inspected before full scan",
          advice: "请先调用 inspect_item 查看全本规模和预算，再决定是否扫描。",
          source: { manifestObject },
        });
      }
      const manifest = await loadManifest(manifestObject, signal);
      const chapters = manifest.content.chapters ?? [];
      const estimatedBytes = chapters.reduce((total, chapter) => total + chapter.size, 0);
      if (estimatedBytes > fullItemByteBudget) {
        return result({
          scanned: false,
          reason: "item exceeds full-scan byte budget",
          estimatedBytes,
          byteBudget: fullItemByteBudget,
          advice: "请先缩小关键词范围，并用 search_content/read_fragment 分批读取。",
        });
      }
      const terms = [...new Set(args.terms.map((term) => term.trim()).filter(Boolean))].slice(0, 12);
      if (!terms.length) throw new Error("扫描整本至少需要一个关键词");
      const evidence: Array<{ datasetId: string; itemId: string; itemTitle: string; chapterId: string; title: string; occurrences: number; text: string; fragmentObject: string }> = [];
      const termTotals = new Map(terms.map((term) => [term, 0]));
      let downloadedBytes = 0;
      for (const chapter of chapters) {
        const object = resolveJoxObject(manifestObject, chapter.object);
        const bytes = await jox.fetchBytes(object, signal);
        downloadedBytes += bytes.length;
        const fragment = asJojoFragment(await gunzipJoxJson<JojoFragment>(bytes, object));
        const text = textBody(fragment);
        for (const term of terms) termTotals.set(term, termTotals.get(term)! + occurrences(text, [term]));
        evidence.push({
          datasetId: manifest.datasetId,
          itemId: manifest.itemId,
          itemTitle: manifest.title,
          chapterId: fragment.fragmentId,
          title: fragment.title,
          occurrences: occurrences(text, terms),
          text: excerpt(text, terms, 3_500),
          fragmentObject: object,
        });
      }
      evidence.sort((left, right) => right.occurrences - left.occurrences || left.chapterId.localeCompare(right.chapterId));
      const limit = Math.max(1, Math.min(12, Math.floor(args.maxEvidenceChapters ?? 6)));
      const matchingEvidence = evidence.filter((entry) => entry.occurrences > 0);
      return result({
        scanned: true,
        intent: args.intent,
        itemId: manifest.itemId,
        title: manifest.title,
        scannedChapterCount: chapters.length,
        downloadedBytes,
        terms,
        totalOccurrences: Object.fromEntries(termTotals),
        evidence: (matchingEvidence.length ? matchingEvidence : evidence).slice(0, limit),
        source: { manifestObject },
      });
    },
  };
  return [
    listLibraryTool,
    listBookItemsTool,
    ...(scope.manifestObjects?.length === 1 ? [selectedSearchTool] : []),
    searchTool,
    fragmentTool,
    inspectTool,
    tocTool,
    itemTool,
  ];
}
