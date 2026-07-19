import axios from "axios";

const BASE = import.meta.env.VITE_API_BASE || "";

export interface DocumentSummary {
  id: string;
  title: string;
  originalName: string;
  sizeBytes: number;
  lineCount: number;
  createdAt: string;
}

export interface AgentHealth {
  status: string;
  agent: { mode: string; model: string; configured: boolean };
}

export interface CitationReference {
  documentId: string;
  startLine: number;
  endLine: number;
}

export interface UsageSummary {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  modelCostUsd: number;
  durationMs: number;
  functionCostCnyEstimate: number;
}

export type ChatStreamEvent =
  | { type: "status"; message: string }
  | { type: "trace"; tool: string; message: string }
  | { type: "chunk"; content: string }
  | { type: "usage"; usage: UsageSummary }
  | { type: "done"; references: CitationReference[] }
  | { type: "error"; message: string };

async function unwrap<T>(promise: Promise<{ data: unknown }>): Promise<T> {
  const response = await promise;
  const body = response.data as { success?: boolean; data?: T; error?: string };
  if (body.success === false) throw new Error(body.error || "请求失败");
  return body.data ?? (body as T);
}

async function request<T>(method: string, url: string, data?: unknown, token?: string): Promise<T> {
  return unwrap<T>(
    axios({
      method,
      url: `${BASE}${url}`,
      data,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    }),
  );
}

export const healthApi = {
  get: () => unwrap<AgentHealth>(axios.get(`${BASE}/api/health`)),
};

export const documentApi = {
  list: () => unwrap<DocumentSummary[]>(axios.get(`${BASE}/api/documents`)),
  add: async (file: File, title?: string) => {
    const data = new FormData();
    if (title?.trim()) data.append("title", title.trim());
    data.append("file", file);
    return unwrap<DocumentSummary>(axios.post(`${BASE}/api/documents`, data));
  },
  remove: (id: string) => unwrap<void>(axios.delete(`${BASE}/api/documents/${id}`)),
};

// Reader compatibility while the old catalog is migrated separately.
export const catalogApi = {
  getSourceDocument: (libraryId: string, documentId: string) =>
    request<any>("get", `/api/catalog/notebooks/${libraryId}/sources/${documentId}/document`),
  getSourceChapter: (libraryId: string, documentId: string, chapterId: string) =>
    request<string | { text?: string }>(
      "get",
      `/api/catalog/notebooks/${libraryId}/sources/${documentId}/chapters/${chapterId}`,
    ),
};

// Legacy admin API remains typed during the incremental migration, but is no longer routed from App.tsx.
export const adminApi = {
  login: (password: string) => request<{ token: string }>("post", "/admin/login", { password }),
  getAccounts: (token: string) => request<any[]>("get", "/admin/config", undefined, token),
  addAccount: (token: string, data: any) => request<any>("post", "/admin/accounts", data, token),
  refreshAccount: (token: string, id: string) => request<any>("post", `/admin/accounts/${id}/refresh`, undefined, token),
  deleteAccount: (token: string, id: string) => request<any>("delete", `/admin/accounts/${id}`, undefined, token),
  listNotebooks: (token: string) => request<any[]>("get", "/admin/notebooks", undefined, token),
  updateNotebook: (token: string, id: string, data: any) => request<any>("put", `/admin/notebooks/${id}`, data, token),
  listSources: (token: string, libraryId: string) => request<any[]>("get", `/admin/notebooks/${libraryId}/sources`, undefined, token),
  updateSource: (token: string, libraryId: string, documentId: string, data: any) =>
    request<any>("put", `/admin/notebooks/${libraryId}/sources/${documentId}`, data, token),
};

export function askStream(
  params: {
    question: string;
    documentIds: string[];
    history: Array<{ role: "user" | "assistant"; content: string }>;
  },
  onEvent: (event: ChatStreamEvent) => void,
  onError: (error: string) => void,
) {
  const controller = new AbortController();

  void fetch(`${BASE}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `请求失败（${response.status}）`);
      }
      if (!response.body) throw new Error("浏览器没有收到流式响应");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const line = block.split("\n").find((entry) => entry.startsWith("data:"));
          if (!line) continue;
          const event = JSON.parse(line.slice(5).trim()) as ChatStreamEvent;
          onEvent(event);
        }
      }
    })
    .catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      onError(error instanceof Error ? error.message : String(error));
    });

  return () => controller.abort();
}
