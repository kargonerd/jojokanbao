export interface ContentDiagnostic {
  level: "warning" | "error";
  code: string;
  message: string;
  source?: string;
}

export interface ContentReport {
  inputFiles: number;
  acceptedFiles: number;
  rejectedFiles: number;
  duplicateFiles: number;
  datasets: number;
  items: number;
  chapters: number;
  searchDocuments: number;
  assets: number;
  annotations: number;
  itemsBuilt: Array<{
    itemId: string;
    itemTitle: string;
    chapters: number;
    characters: number;
    assets: number;
  }>;
  diagnostics: ContentDiagnostic[];
}

export interface ContentJob {
  jobId: string;
  status: string;
  phase: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  inputPaths: string[];
  publicationStatus: "draft" | "published";
  access: "public" | "authenticated";
  outputDirectory: string;
  progress: Record<string, unknown>;
  report: ContentReport | null;
  publish: Record<string, { status: string; message?: string; result?: Record<string, unknown> }>;
  logs: string[];
}

export interface PublisherStatus {
  b2: { configured: boolean; rawRemote: string; deliveryRemote: string };
  elasticsearch: { configured: boolean; index: string };
  huggingface: { configured: boolean; repoId: string; private: boolean };
}

async function json<T>(response: Response): Promise<T> {
  const payload = await response.json() as T & { success?: boolean; message?: string };
  if (!response.ok || payload.success === false) throw new Error(payload.message || `HTTP ${response.status}`);
  return payload;
}

export const contentApi = {
  status: () => fetch("/api/content/status").then((response) => json<{ success: true; publishers: PublisherStatus }>(response)),
  jobs: () => fetch("/api/content/jobs").then((response) => json<{ success: true; jobs: ContentJob[] }>(response)),
  job: (jobId: string) => fetch(`/api/content/jobs/${jobId}`).then((response) => json<{ success: true; job: ContentJob }>(response)),
  browse: () => fetch("/api/browse-folder", { method: "POST" }).then((response) => json<{ success: true; path: string }>(response)),
  importPaths: (paths: string[], fetchAssets: boolean, publicationStatus: "draft" | "published", access: "public" | "authenticated") => fetch("/api/content/import-paths", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths, fetchAssets, publicationStatus, access }),
  }).then((response) => json<{ success: true; job: ContentJob }>(response)),
  importFiles: (files: File[], fetchAssets: boolean, publicationStatus: "draft" | "published", access: "public" | "authenticated") => {
    const body = new FormData();
    files.forEach((file) => body.append("files", file));
    body.append("fetchAssets", String(fetchAssets));
    body.append("publicationStatus", publicationStatus);
    body.append("access", access);
    return fetch("/api/content/import-files", { method: "POST", body })
      .then((response) => json<{ success: true; job: ContentJob }>(response));
  },
  publish: (jobId: string, targets: string[]) => fetch(`/api/content/jobs/${jobId}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targets }),
  }).then((response) => json<{ success: true; job: ContentJob }>(response)),
};
