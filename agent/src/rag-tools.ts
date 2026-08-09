import {
  JoxClient,
  asJojoFragment,
  asJojoItemManifest,
  gunzipJoxJson,
  resolveJoxObject,
  type JojoFragment,
  type JojoItemManifest,
} from "@jojo/content";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

export interface RagScope {
  datasetIds?: string[];
  itemIds?: string[];
}

export interface RagToolOptions {
  searchUrl: string;
  contentCdnBase: string;
  scope?: RagScope;
  fetchFn?: typeof fetch;
  fullItemByteBudget?: number;
}

interface SearchHit {
  datasetId: string;
  datasetTitle: string;
  itemId: string;
  itemTitle: string;
  targetId: string;
  targetTitle: string;
  text: string;
  manifestObject: string;
  fragmentObject: string;
  score?: number;
}

function safeObjectKey(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized.startsWith("content/") || !normalized.endsWith(".jox") || normalized.includes("../")) {
    throw new Error("非法 Jox 对象路径");
  }
  return normalized;
}

function enforceDatasetObjectScope(objectKey: string, scope: RagScope): void {
  if (scope.datasetIds?.length && !scope.datasetIds.some((datasetId) => objectKey.startsWith(`content/${datasetId}/`))) {
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
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function scoped(values: string[] | undefined, allowed: string[] | undefined): string[] | undefined {
  if (allowed?.length) return allowed;
  return values?.length ? values : undefined;
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

export function createRagTools(options: RagToolOptions): AgentTool[] {
  const fetchFn = options.fetchFn ?? fetch;
  const jox = new JoxClient(options.contentCdnBase, fetchFn);
  const scope = options.scope ?? {};
  const manifestCache = new Map<string, JojoItemManifest>();
  const inspectedManifests = new Set<string>();
  const fullItemByteBudget = options.fullItemByteBudget ?? 32 * 1024 * 1024;

  function enforceManifestScope(manifest: JojoItemManifest): void {
    if (scope.datasetIds?.length && !scope.datasetIds.includes(manifest.datasetId)) {
      throw new Error("该 Dataset 不在用户选择范围内");
    }
    if (scope.itemIds?.length && !scope.itemIds.includes(manifest.itemId)) {
      throw new Error("该 Item 不在用户选择范围内");
    }
  }

  async function loadManifest(object: string, signal?: AbortSignal): Promise<JojoItemManifest> {
    const cached = manifestCache.get(object);
    if (cached) return cached;
    const manifest = asJojoItemManifest(await jox.fetchJson<JojoItemManifest>(object, signal));
    enforceManifestScope(manifest);
    manifestCache.set(object, manifest);
    return manifest;
  }

  const searchParameters = Type.Object({
    query: Type.String({ description: "要检索的原文关键词或问题" }),
    size: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
    datasetIds: Type.Optional(Type.Array(Type.String())),
    itemIds: Type.Optional(Type.Array(Type.String())),
  });
  const searchTool: AgentTool<typeof searchParameters> = {
    name: "search_content",
    label: "搜索馆藏",
    description: "在 Elasticsearch 中搜索书籍、报纸和杂志。先调用它定位证据；结果给出可继续读取的 manifestObject 和 fragmentObject。",
    parameters: searchParameters,
    async execute(_callId, args, signal) {
      const response = await fetchFn(options.searchUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: args.query,
          size: Math.max(1, Math.min(20, Math.floor(args.size ?? 8))),
          datasetIds: scoped(args.datasetIds, scope.datasetIds),
          itemIds: scoped(args.itemIds, scope.itemIds),
        }),
        signal,
      });
      if (!response.ok) throw new Error(`搜索服务返回 HTTP ${response.status}`);
      const payload = await response.json() as { data?: { total?: number; results?: SearchHit[] }; results?: SearchHit[] };
      const hits = payload.data?.results ?? payload.results ?? [];
      return result({ total: payload.data?.total ?? hits.length, hits });
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
    manifestObject: Type.String({ description: "search_content 返回的 manifestObject" }),
  });
  const inspectTool: AgentTool<typeof inspectParameters> = {
    name: "inspect_item",
    label: "查看全本规模",
    description: "考虑扫描全本时先调用。只读取小型 manifest，返回章节数、字符数、预计处理量和预算，不下载正文；由 Agent 决定是否继续调用 scan_full_item。",
    parameters: inspectParameters,
    async execute(_callId, args, signal) {
      const manifestObject = safeObjectKey(args.manifestObject);
      enforceDatasetObjectScope(manifestObject, scope);
      const manifest = await loadManifest(manifestObject, signal);
      const chapters = manifest.content.chapters ?? [];
      const estimatedBytes = chapters.reduce((total, chapter) => total + chapter.size, 0);
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
        firstChapters: chapters.slice(0, 8).map((chapter) => ({
          id: chapter.id,
          order: chapter.order,
          title: chapter.title,
        })),
        source: { manifestObject },
      });
    },
  };

  const itemParameters = Type.Object({
    manifestObject: Type.String({ description: "search_content 返回的 manifestObject" }),
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
      const manifestObject = safeObjectKey(args.manifestObject);
      enforceDatasetObjectScope(manifestObject, scope);
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
      const evidence: Array<{ chapterId: string; title: string; occurrences: number; text: string; fragmentObject: string }> = [];
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
  return [searchTool, fragmentTool, inspectTool, itemTool];
}
