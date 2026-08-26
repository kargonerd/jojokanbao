import { supportsJojoDatasetAi } from "@jojo/content";
import { loadCatalog, loadDataset } from "./content";
import type {
  RagNotebook,
  RagMessage,
  RagReference,
  RagSource,
} from "./types";

const AGENT_URL = "/gateway/ask";

export interface RagStreamActivity {
  phase: "connecting" | "thinking" | "searching" | "reading" | "writing";
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function shortArgument(args: unknown, key: string): string | undefined {
  if (!isRecord(args) || typeof args[key] !== "string") return undefined;
  const value = args[key].replace(/\s+/g, " ").trim();
  return value ? value.slice(0, 32) : undefined;
}

function toolActivity(name: unknown, args: unknown, isError?: boolean): RagStreamActivity {
  if (isError) {
    return {
      phase: "thinking",
      message: "这一步没有取得结果，正在调整检索方式…",
    };
  }
  const query = shortArgument(args, "query") || shortArgument(args, "titleQuery");
  const suffix = query ? `：“${query}”` : "…";
  switch (name) {
    case "list_library_books":
      return { phase: "searching", message: `正在筛选可能相关的书籍${suffix}` };
    case "list_book_items":
      return { phase: "searching", message: "正在查看候选书籍及分卷…" };
    case "search_selected_item":
      return { phase: "searching", message: `正在当前书籍中检索原文${suffix}` };
    case "search_content":
      return { phase: "searching", message: `正在候选书籍中检索原文${suffix}` };
    case "inspect_item":
      return { phase: "reading", message: "正在读取书籍概况…" };
    case "list_item_toc":
      return { phase: "reading", message: "正在查看书籍目录并选择相关章节…" };
    case "read_fragment":
      return { phase: "reading", message: "正在读取命中的相关章节…" };
    case "scan_full_item":
      return { phase: "reading", message: "正在按关键词扫描全书并提取证据…" };
    default:
      return { phase: "thinking", message: "正在核对馆藏资料…" };
  }
}

async function accessToken(): Promise<string> {
  const { authClient } = await import("../account/auth");
  const { data, error } = await authClient.auth.getSession();
  if (error) throw error;
  const token = data.session?.access_token;
  if (!token) throw new Error("请先登录后使用 AI");
  return token;
}

// Public
export const notebookApi = {
  list: async (): Promise<RagNotebook[]> => (await loadCatalog()).datasets.filter((dataset) => (
    dataset.publicationStatus !== "draft" && supportsJojoDatasetAi(dataset)
  )).map((dataset) => ({
    id: dataset.datasetId,
    title: dataset.title,
    sources_count: dataset.itemCount,
    type: dataset.type,
    indexObject: dataset.indexObject,
    aiEnabled: dataset.aiEnabled,
  })),
  getSources: async (nid: string): Promise<RagSource[]> => (await loadDataset(nid)).index.items.filter((item) => item.publicationStatus !== "draft").map((item) => ({
    id: item.itemId,
    itemId: item.itemId,
    itemKey: item.itemKey,
    title: item.title,
    published: item.publicationStatus !== "draft",
    manifestObject: item.manifestObject,
  })),
  getSourceFulltext: () => Promise.reject(new Error("请从书籍章节中按需读取内容")),
};

// Chat (streaming)
export function askStream(params: { datasetIds: string[]; scopeMode: "all" | "selected"; question: string; conversationId?: string; itemIds?: string[]; manifestObjects?: string[]; history?: RagMessage[] }, onChunk: (text: string) => void, onDone: (refs?: RagReference[], conversationId?: string) => void, onError: (err: string) => void, onActivity?: (activity: RagStreamActivity) => void) {
  const ctrl = new AbortController();
  let settled = false;
  const conversationId = params.conversationId || `conv_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const references = new Map<string, RagReference>();
  let answer = "";
  const mergeReference = (reference: RagReference) => {
    const key = [
      reference.datasetId || "",
      reference.itemId || "",
      reference.targetId || "",
      reference.anchorId || "",
    ].join("\0");
    references.set(key, { ...references.get(key), ...reference });
  };
  const finish = (candidates?: RagReference[]) => {
    if (settled) return;
    settled = true;
    const citationIds = [...answer.matchAll(/\[cite:([A-Za-z0-9_-]+)\]/g)]
      .map((match) => match[1])
      .filter((citationId): citationId is string => Boolean(citationId));
    if (!citationIds.length) {
      onDone(candidates, conversationId);
      return;
    }
    const byCitationId = new Map((candidates ?? []).flatMap((reference) => reference.citationId
      ? [[reference.citationId, reference] as const]
      : []));
    onDone([...new Set(citationIds)].flatMap((citationId) => {
      const reference = byCitationId.get(citationId);
      return reference ? [reference] : [];
    }), conversationId);
  };

  void (async () => {
    onActivity?.({ phase: "connecting", message: "正在确认登录状态…" });
    const token = await accessToken();
    onActivity?.({ phase: "connecting", message: "JOJO 正在连接馆藏…" });
    const response = await fetch(AGENT_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Makers-Conversation-Id": conversationId,
      },
      body: JSON.stringify({
        message: params.question,
        historyMode: "client",
        history: (params.history ?? []).slice(-20).map((message) => ({
          role: message.role,
          content: message.content.replace(/\[cite:[A-Za-z0-9_-]+\]/g, ""),
        })),
        scope: {
          mode: params.scopeMode,
          datasetIds: params.datasetIds,
          itemIds: params.itemIds ?? [],
          manifestObjects: params.manifestObjects ?? [],
        },
      }),
      signal: ctrl.signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(payload.error || `问答服务返回 HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("问答服务没有返回数据");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let writingStarted = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop()!;
      for (const frame of frames) {
        const lines = frame.split("\n");
        const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
        const payloadText = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (!payloadText) continue;
        const event = JSON.parse(payloadText) as Record<string, unknown>;
        if (eventName === "status") {
          onActivity?.({ phase: "thinking", message: "正在分析问题并选择资料…" });
        } else if (eventName === "tool_start") {
          onActivity?.(toolActivity(event.name, event.args));
        } else if (eventName === "tool_end") {
          if (Array.isArray(event.references)) {
            for (const candidate of event.references) {
              if (!isRecord(candidate)) continue;
              const reference = candidate as RagReference;
              mergeReference(reference);
            }
          }
          onActivity?.(event.isError === true
            ? toolActivity(event.name, undefined, true)
            : { phase: "thinking", message: "已取得一批资料，正在判断是否需要继续查找…" });
        } else if (eventName === "turn_end") {
          onActivity?.({ phase: "thinking", message: "正在核对证据与引用位置…" });
        } else if (eventName === "text_delta" && typeof event.delta === "string") {
          if (!writingStarted) {
            writingStarted = true;
            onActivity?.({ phase: "writing", message: "正在根据原文组织回答…" });
          }
          answer += event.delta;
          onChunk(event.delta);
        } else if (eventName === "done") { finish([...references.values()]); return; }
        else if (eventName === "error") {
          settled = true;
          onError(typeof event.message === "string" ? event.message : "回答生成失败，请重试");
          return;
        }
      }
    }
    finish();
  })().catch((error: unknown) => {
    if (error instanceof DOMException && error.name === "AbortError") return;
    settled = true;
    onError(error instanceof Error ? error.message : String(error));
  });
  return () => ctrl.abort();
}
