import axios from "axios";
import { loadCatalog, loadDataset } from "./content";
import type {
  RagAdminAccount,
  RagAdminConfig,
  RagAnalysis,
  RagNotebook,
  RagPerson,
  RagReference,
  RagSource,
  RagSourceDocument,
} from "./types";

const BASE = (import.meta.env.VITE_RAG_API_BASE || "").replace(/\/$/, "");
const AGENT_URL = import.meta.env.VITE_AGENT_API_URL?.trim();

type HttpMethod = "delete" | "get" | "post" | "put";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function request<T>(method: HttpMethod, url: string, data?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await axios({ method, url: `${BASE}${url}`, data, headers });
  const body: unknown = res.data;
  if (isRecord(body) && body.success === false) {
    throw new Error(typeof body.error === "string" ? body.error : "请求失败");
  }
  if (isRecord(body) && "data" in body) return body.data as T;
  return body as T;
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

export const catalogApi = {
  listNotebooks: () => request<RagNotebook[]>("get", "/api/catalog/notebooks"),
  getNotebook: (id: string) => request<RagNotebook>("get", `/api/catalog/notebooks/${encodeURIComponent(id)}`),
  getSourceDocument: (nid: string, sid: string) => request<RagSourceDocument>("get", `/api/catalog/notebooks/${nid}/sources/${sid}/document`),
  getSourceChapter: (nid: string, sid: string, chapterId: string) => request<string | { text?: string }>("get", `/api/catalog/notebooks/${nid}/sources/${sid}/chapters/${chapterId}`),
  getPersons: (nid: string, sid: string) => request<RagPerson[]>("get", `/api/catalog/notebooks/${nid}/sources/${sid}/analysis/persons`),
  getPersonEvents: (nid: string, sid: string, name: string) => request<RagAnalysis>("get", `/api/catalog/notebooks/${nid}/sources/${sid}/analysis/persons/${encodeURIComponent(name)}/events`),
  getTimeline: (nid: string, sid: string, query: string) => request<RagAnalysis>("post", `/api/catalog/notebooks/${nid}/sources/${sid}/analysis/timeline`, { query }),
  getRelations: (nid: string, sid: string, query: string) => request<RagAnalysis>("post", `/api/catalog/notebooks/${nid}/sources/${sid}/analysis/relations`, { query }),
};

// Chat (streaming)
export function askStream(params: { dataset_id: string; question: string; conversation_id?: string; item_ids?: string[] }, onChunk: (text: string) => void, onDone: (refs?: RagReference[], conversationId?: string) => void, onError: (err: string) => void) {
  const ctrl = new AbortController();
  let settled = false;
  const conversationId = params.conversation_id || `conv_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const references = new Map<string, RagReference>();
  const finish = (references?: RagReference[]) => {
    if (settled) return;
    settled = true;
    onDone(references, conversationId);
  };

  void (async () => {
    if (!AGENT_URL) throw new Error("书内 AI 服务尚未部署");
    const { authClient } = await import("../account/auth");
    const { data, error } = await authClient.auth.getSession();
    if (error) throw error;
    const token = data.session?.access_token;
    if (!token) throw new Error("请先登录后使用 JOJO Agent");
    const response = await fetch(AGENT_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Makers-Conversation-Id": conversationId,
      },
      body: JSON.stringify({
        message: params.question,
        scope: { datasetIds: [params.dataset_id], itemIds: params.item_ids ?? [] },
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

// Admin
export const adminApi = {
  login: (password: string) => request<{ token: string }>("post", "/admin/login", { password }),
  getAccounts: async (token: string): Promise<RagAdminAccount[]> => (await request<RagAdminConfig>("get", "/admin/config", undefined, token)).accounts,
  addAccount: (token: string, data: { name: string; cookie: string }) => request<{ accounts: RagAdminAccount[] }>("post", "/admin/accounts", data, token),
  refreshAccount: (token: string, id: number) => request<{ accounts: RagAdminAccount[] }>("post", `/admin/accounts/${id}/refresh`, undefined, token),
  deleteAccount: (token: string, id: number) => request<{ accounts: RagAdminAccount[] }>("delete", `/admin/accounts/${id}`, undefined, token),
  listNotebooks: (token: string) => request<RagNotebook[]>("get", "/admin/notebooks", undefined, token),
  updateNotebook: (token: string, id: string, data: { title: string }) => request<RagNotebook>("put", `/admin/notebooks/${id}`, data, token),
  listSources: (token: string, nid: string) => request<RagSource[]>("get", `/admin/notebooks/${nid}/sources`, undefined, token),
  updateSource: (token: string, nid: string, sid: string, data: { title: string; published: boolean }) => request<RagSource>("put", `/admin/notebooks/${nid}/sources/${sid}`, data, token),
};
