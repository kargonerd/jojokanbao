export interface ApiResult {
  success: boolean;
  message?: string;
}

export interface StorageInfo {
  backend?: string;
  backend_type?: string;
  processed_path?: string;
  split_path?: string;
}

export interface Publication {
  code: string;
  name: string;
  type: "newspaper" | "journal";
  vue_name?: string;
  source_path?: string;
  storage?: StorageInfo;
  processed_path?: string;
  split_path?: string;
  date_format?: string;
  description?: string;
  default_date?: string;
}

export interface FileMapping {
  original: string;
  renamed: string;
  success: boolean;
  rel_path?: string;
  error?: string;
}

export interface Progress {
  status:
    | "pending"
    | "processing"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "not_found";
  task_type?: "staging" | "commit";
  unit_label?: string;
  completed_files?: number;
  total_files?: number;
  current_page?: number;
  total_pages?: number;
  processing_files?: Record<
    string,
    { status: string; current_page?: number; total_pages?: number }
  >;
  results?: StagingResult | CommitResult;
  error?: string;
}

export interface StagedFile {
  original?: string;
  renamed?: string;
  processed_path?: string;
  split_count?: number;
}

export interface StagingResult {
  success: boolean;
  staging_id: string;
  preview?: StagedFile[];
  skipped?: Array<{ original?: string; reason?: string }>;
  errors?: Array<{ original?: string; error?: string } | string>;
  message?: string;
}

export interface CommitResult {
  success: boolean;
  message?: string;
  stats?: { processed?: number; split?: number; total?: number };
}

export interface TaskResponse extends ApiResult {
  task_id: string;
  staging_id?: string;
}

export interface ScanResponse extends ApiResult {
  mapping: FileMapping[];
  ai_prompt?: string;
  stats: { total: number; success: number; failed: number };
}

export interface RuleResponse extends ApiResult {
  results: FileMapping[];
}

export interface MultiFileChange {
  filename: string;
  filepath: string;
  status: "added" | "modified" | "unchanged";
  old_code: string;
  new_code: string;
  additions: number;
  deletions: number;
}

export interface MultiFileDiff {
  files: MultiFileChange[];
  total_additions?: number;
  total_deletions?: number;
  total_files?: number;
}

export interface VuePreview extends ApiResult {
  exists?: boolean;
  old_code?: string;
  new_code?: string;
  diff_html?: string;
  vue_filename?: string;
  multi_file_diff?: MultiFileDiff;
}

export interface SearchDocument {
  documentId: string;
  title?: string;
  content?: string;
  date?: string;
  page?: number;
  source?: string;
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

export interface MigrationCandidate {
  version: number;
  id: string;
  createdAt: string;
  index: string;
  operation: "repair" | "delete";
  replacedDocumentId: string;
  document: Partial<SearchDocument>;
  reason: string;
  state: "pending";
}

export interface MigrationPreview {
  migration: MigrationCandidate;
  esPayload: Record<string, unknown>;
  previewHash: string;
}

async function parse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(`服务返回了非 JSON 响应（${response.status}）`);
  }
  const payload = (await response.json()) as T & {
    success?: boolean;
    message?: string;
  };
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
    try {
      const progress = JSON.parse(event.data) as Progress;
      onProgress(progress);
      if (
        ["completed", "failed", "cancelled", "not_found"].includes(
          progress.status,
        )
      ) {
        source.close();
      }
    } catch {
      source.close();
      onDisconnect();
    }
  };
  source.onerror = () => {
    source.close();
    onDisconnect();
  };
  return () => source.close();
}
