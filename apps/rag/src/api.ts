import axios from "axios";

const BASE = import.meta.env.VITE_API_BASE || "";

async function request<T>(method: string, url: string, data?: any, token?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await axios({ method, url: `${BASE}${url}`, data, headers });
  const body = res.data;
  if (body.success === false) throw new Error(body.error || "请求失败");
  return body.data ?? body;
}

// Public
export const notebookApi = {
  list: () => request<any[]>("get", "/api/notebooks"),
  getSources: (nid: string) => request<any[]>("get", `/api/notebooks/${nid}/sources`),
  getSourceFulltext: (nid: string, sid: string) => request<string>("get", `/api/notebooks/${nid}/sources/${sid}/fulltext`),
};

export const catalogApi = {
  listNotebooks: () => request<any[]>("get", "/api/catalog/notebooks"),
  getNotebook: (id: string) => request<any>("get", `/api/catalog/notebooks/${id}`),
  getSourceDocument: (nid: string, sid: string) => request<any>("get", `/api/catalog/notebooks/${nid}/sources/${sid}/document`),
  getSourceChapter: (nid: string, sid: string, chapterId: string) => request<string | { text?: string }>("get", `/api/catalog/notebooks/${nid}/sources/${sid}/chapters/${chapterId}`),
  getPersons: (nid: string, sid: string) => request<any[]>("get", `/api/catalog/notebooks/${nid}/sources/${sid}/analysis/persons`),
  getPersonEvents: (nid: string, sid: string, name: string) => request<any[]>("get", `/api/catalog/notebooks/${nid}/sources/${sid}/analysis/persons/${name}/events`),
  getTimeline: (nid: string, sid: string, query: string) => request<any>("post", `/api/catalog/notebooks/${nid}/sources/${sid}/analysis/timeline`, { query }),
  getRelations: (nid: string, sid: string, query: string) => request<any>("post", `/api/catalog/notebooks/${nid}/sources/${sid}/analysis/relations`, { query }),
};

// Chat (streaming)
export function askStream(params: { notebook_id: string; question: string; conversation_id?: string; source_ids?: string[] }, onChunk: (text: string) => void, onDone: (refs?: any[]) => void, onError: (err: string) => void) {
  const ctrl = new AbortController();
  fetch(`${BASE}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: ctrl.signal,
  }).then(async (res) => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") { onDone(); return; }
        try {
          const obj = JSON.parse(payload);
          if (obj.type === "chunk") onChunk(obj.content);
          else if (obj.type === "done") onDone(obj.references);
          else if (obj.type === "error") onError(obj.message);
        } catch { onChunk(payload); }
      }
    }
    onDone();
  }).catch((err) => { if (err.name !== "AbortError") onError(String(err)); });
  return () => ctrl.abort();
}

// Admin
export const adminApi = {
  login: (password: string) => request<{ token: string }>("post", "/admin/login", { password }),
  getAccounts: (token: string) => request<any[]>("get", "/admin/config", undefined, token),
  addAccount: (token: string, data: any) => request<any>("post", "/admin/accounts", data, token),
  refreshAccount: (token: string, id: string) => request<any>("post", `/admin/accounts/${id}/refresh`, undefined, token),
  deleteAccount: (token: string, id: string) => request<any>("delete", `/admin/accounts/${id}`, undefined, token),
  listNotebooks: (token: string) => request<any[]>("get", "/admin/notebooks", undefined, token),
  updateNotebook: (token: string, id: string, data: any) => request<any>("put", `/admin/notebooks/${id}`, data, token),
  listSources: (token: string, nid: string) => request<any[]>("get", `/admin/notebooks/${nid}/sources`, undefined, token),
  updateSource: (token: string, nid: string, sid: string, data: any) => request<any>("put", `/admin/notebooks/${nid}/sources/${sid}`, data, token),
};
