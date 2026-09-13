import type { LibrarySourceId } from "@jojo/content";
import { adminFetch } from "../auth/request";
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
    manifestObject: string;
    chapters: number;
    characters: number;
    assets: number;
  }>;
  diagnostics: ContentDiagnostic[];
}

export interface ContentPublication {
  librarySource?: LibrarySourceId;
  status: string;
  completedAt?: string;
  failedAt?: string;
  publicationStatus?: "draft" | "published";
  access?: "public" | "authenticated";
  message?: string;
  result?: Record<string, unknown> & { cache?: { status: string; objects: number; origin: string } };
  lastSuccessful?: ContentPublication;
}

export interface ContentJob {
  librarySource?: LibrarySourceId;
  jobId: string;
  newerJobId?: string | null;
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
  publish: Record<string, ContentPublication>;
  logs: string[];
}

export interface PublisherStatus {
  elasticsearch?: { configured: boolean; index: string };
  b2: { configured: boolean; deliveryRemote: string };
  huggingface: { configured: boolean; repoId: string; private: boolean };
}

async function json<T>(response: Response): Promise<T> {
  const payload = await response.json() as T & { success?: boolean; message?: string };
  if (!response.ok || payload.success === false) throw new Error(payload.message || `HTTP ${response.status}`);
  return payload;
}

export const contentApi = {
  status: () => adminFetch("/api/content/status").then((response) => json<{ success: true; publishers: PublisherStatus }>(response)),
  jobs: () => adminFetch("/api/content/jobs").then((response) => json<{ success: true; jobs: ContentJob[] }>(response)),
  job: (jobId: string) => adminFetch(`/api/content/jobs/${jobId}`).then((response) => json<{ success: true; job: ContentJob }>(response)),
  importFile: (file: File, fetchAssets: boolean, publicationStatus: "draft" | "published", access: "public" | "authenticated", librarySource: LibrarySourceId) => {
    const body = new FormData();
    body.append("files", file);
    body.append("fetchAssets", String(fetchAssets));
    body.append("publicationStatus", publicationStatus);
    body.append("access", access);
    body.append("librarySource", librarySource);
    return adminFetch("/api/content/import-files", { method: "POST", body })
      .then((response) => json<{ success: true; job: ContentJob }>(response));
  },
  publish: (jobId: string, targets: string[], publicationStatus: ContentJob["publicationStatus"], access: ContentJob["access"]) => adminFetch(`/api/content/jobs/${jobId}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targets, publicationStatus, access }),
  }).then((response) => json<{ success: true; job: ContentJob }>(response)),
};
