import { loadCatalog, loadDataset } from "./content";
import type {
  RagNotebook,
  RagReference,
  RagSource,
} from "./types";

const AGENT_URL = "/gateway/ask";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
// Public
export const notebookApi = {
  list: async (): Promise<RagNotebook[]> => (await loadCatalog()).datasets.filter((dataset) => dataset.publicationStatus !== "draft").map((dataset) => ({
    id: dataset.datasetId,
    title: dataset.title,
    sources_count: dataset.itemCount,
    type: dataset.type,
    indexObject: dataset.indexObject,
  })),
  getSources: async (nid: string): Promise<RagSource[]> => (await loadDataset(nid)).index.items.filter((item) => item.publicationStatus !== "draft").map((item) => ({
    id: item.itemId,
    itemId: item.itemId,
    itemKey: item.itemKey,
    title: item.title,
    published: item.publicationStatus !== "draft",
    manifestObject: item.manifestObject,
  })),
  getSourceFulltext: () => Promise.reject(new Error("请通过章节或 Agent 按需读取内容")),
};

// Chat (streaming)
export function askStream(params: { datasetIds: string[]; question: string; conversationId?: string; itemIds?: string[]; manifestObjects?: string[] }, onChunk: (text: string) => void, onDone: (refs?: RagReference[], conversationId?: string) => void, onError: (err: string) => void) {
  const ctrl = new AbortController();
  let settled = false;
  const conversationId = params.conversationId || `conv_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const references = new Map<string, RagReference>();
  const finish = (references?: RagReference[]) => {
    if (settled) return;
    settled = true;
    onDone(references, conversationId);
  };

  void (async () => {
    const { authClient } = await import("../account/auth");
    const { data, error } = await authClient.auth.getSession();
    if (error) throw error;
    const token = data.session?.access_token;
    if (!token) throw new Error("请先登录后使用问书");
    const response = await fetch(AGENT_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Makers-Conversation-Id": conversationId,
      },
      body: JSON.stringify({
        message: params.question,
        scope: {
          datasetIds: params.datasetIds,
          itemIds: params.itemIds ?? [],
          manifestObjects: params.manifestObjects ?? [],
        },
      }),
      signal: ctrl.signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(payload.error || `Agent 服务返回 HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("Agent 服务没有返回数据流");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
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
        if (eventName === "text_delta" && typeof event.delta === "string") onChunk(event.delta);
        else if (eventName === "tool_end" && Array.isArray(event.references)) {
          for (const candidate of event.references) {
            if (!isRecord(candidate)) continue;
            const reference = candidate as RagReference;
            const key = `${reference.itemId || ""}:${reference.targetId || ""}:${reference.fragmentObject || ""}`;
            references.set(key, reference);
          }
        }
        else if (eventName === "done") { finish([...references.values()]); return; }
        else if (eventName === "error") {
          settled = true;
          onError(typeof event.message === "string" ? event.message : "Agent 流式请求失败");
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
