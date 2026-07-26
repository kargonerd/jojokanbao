export interface ApiResult {
  success: boolean;
  message?: string;
  [key: string]: unknown;
}

export interface Publication {
  code: string;
  name: string;
  type: "newspaper" | "journal";
  vue_name?: string;
  source_path?: string;
  storage?: unknown;
  processed_path?: string;
  split_path?: string;
  [key: string]: unknown;
}

export interface FileMapping {
  original: string;
  renamed: string;
  success: boolean;
  rel_path?: string;
  error?: string;
  [key: string]: unknown;
}

export interface Progress {
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "not_found";
  task_type?: "staging" | "commit";
  unit_label?: string;
  completed_files?: number;
  total_files?: number;
  current_page?: number;
  total_pages?: number;
  processing_files?: Record<string, { status: string; current_page?: number; total_pages?: number }>;
  result?: StagingResult | Record<string, unknown>;
  error?: string;
}

export interface StagingResult {
  success: boolean;
  staging_id: string;
  preview?: Array<Record<string, unknown>>;
  skipped?: Array<Record<string, unknown>>;
  errors?: Array<Record<string, unknown> | string>;
  message?: string;
  [key: string]: unknown;
}

export interface SearchDocument {
  documentId: string;
  title?: string;
  content?: string;
  date?: string;
  page?: number;
  source?: string;
  [key: string]: unknown;
}

export interface Migration {
  id: string;
  file: string;
  operation: "repair" | "delete";
  state: "pending" | "applied";
  reason?: string;
  createdAt: string;
  result?: { documentId?: string };
}

async function parse<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { success?: boolean; message?: string };
  if (!response.ok || payload.success === false) {
    throw new Error(payload.message || `请求失败（${response.status}）`);
  }
  return payload;
}

export async function apiGet<T>(path: string): Promise<T> {
  return parse<T>(await fetch(path));
}

export async function apiPost<T>(path: string, body: unknown = {}): Promise<T> {
  return parse<T>(
    await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export function watchProgress(
  taskId: string,
  onProgress: (progress: Progress) => void,
  onDisconnect: () => void,
): () => void {
  const source = new EventSource(`/api/progress/${encodeURIComponent(taskId)}`);
  source.onmessage = (event) => {
    const progress = JSON.parse(event.data) as Progress;
    onProgress(progress);
    if (["completed", "failed", "cancelled", "not_found"].includes(progress.status)) source.close();
  };
  source.onerror = () => {
    source.close();
    onDisconnect();
  };
  return () => source.close();
}
