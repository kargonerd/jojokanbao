import axios from "axios";
import { authClient } from "../account/auth";
import type {
  RagAdminAccount,
  RagAdminConfig,
  RagAnalysis,
  RagNotebook,
  RagPerson,
  RagReference,
  RagStreamDone,
  RagSource,
  RagSourceDocument,
} from "./types";

const BASE = (
  import.meta.env.VITE_RAG_API_BASE
  || import.meta.env.VITE_PLATFORM_API_BASE
  || "/api"
).replace(/\/$/, "");

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
  list: () => request<RagNotebook[]>("get", "/v1/rag/notebooks"),
  getSources: (nid: string) => request<RagSource[]>("get", `/v1/rag/notebooks/${encodeURIComponent(nid)}/sources`),
  getSourceFulltext: (nid: string, sid: string) => request<string>("get", `/api/notebooks/${nid}/sources/${sid}/fulltext`),
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
export function askStream(
  params: {
    notebook_id: string;
    question: string;
    conversation_id?: string;
    source_ids: string[];
  },
  onChunk: (text: string) => void,
  onDone: (result: RagStreamDone) => void,
  onError: (err: string) => void,
) {
  const ctrl = new AbortController();
  let settled = false;
  const finish = (result: RagStreamDone = {}) => {
    if (settled) return;
    settled = true;
    onDone(result);
  };

  void authClient.auth.getSession().then(({ data, error }) => {
    if (error) throw error;
    const token = data.session?.access_token;
    if (!token) throw new Error("请先登录 JOJO，再使用文档问答");
    return fetch(`${BASE}/v1/rag/chat/stream`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
    signal: ctrl.signal,
    });
  }).then(async (res) => {
    if (!res.ok) throw new Error(`RAG 服务返回 HTTP ${res.status}`);
    if (!res.body) throw new Error("RAG 服务没有返回数据流");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "";
    let dataLines: string[] = [];
    const dispatch = () => {
      if (dataLines.length === 0) {
        eventName = "";
        return false;
      }
      const payload = dataLines.join("\n");
      const resolvedEvent = eventName || "message";
      eventName = "";
      dataLines = [];
      if (payload === "[DONE]") {
        finish();
        return true;
      }
      let event: unknown;
      try {
        event = JSON.parse(payload);
      } catch {
        if (resolvedEvent === "message") onChunk(payload);
        return false;
      }
      if (!isRecord(event)) return false;
      const legacyType = typeof event.type === "string" ? event.type : undefined;
      const type = resolvedEvent === "message" ? legacyType : resolvedEvent;
      if (
        (type === "text_delta" && typeof event.delta === "string")
        || (type === "chunk" && typeof event.content === "string")
      ) {
        onChunk(type === "text_delta" ? event.delta as string : event.content as string);
      } else if (type === "done") {
        finish({
          conversationId: typeof event.conversationId === "string"
            ? event.conversationId
            : undefined,
          usage: isRecord(event.usage)
            ? event.usage as unknown as RagStreamDone["usage"]
            : undefined,
        });
        return true;
      } else if (type === "error") {
        settled = true;
        onError(typeof event.message === "string" ? event.message : "RAG 流式请求失败");
        return true;
      }
      return false;
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop()!;
      for (const line of lines) {
        if (!line) {
          if (dispatch()) return;
        } else if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }
    if (buffer) dataLines.push(buffer);
    dispatch();
    finish();
  }).catch((error: unknown) => {
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
