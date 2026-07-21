import type {
  ExportOption,
  ProjectMetadataConfirmation,
  ProjectMetadataConfirmationUpdate,
  ProjectMetadataSaveResult,
  ProjectOverview,
  QualityStatus
} from '../types/project';
import type { ProofreadBlock, ProofreadWorkspace } from '../types/issues';

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8765';

let apiBaseUrlOverride: string | null = null;

export interface Project {
  id: string;
  title: string;
  currentStage: string;
  createdAt?: string | null;
  name?: string;
  path?: string | null;
  coverUrl?: string | null;
}

export interface RecognitionTask {
  project_id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  engine: string;
  language: string;
  is_ocr: boolean;
  pdf_path: string;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

function getElectronApiBaseUrl() {
  return typeof window !== 'undefined' ? window.jojoPress?.apiBaseUrl : undefined;
}

export function setApiBaseUrlOverride(value: string | null) {
  apiBaseUrlOverride = value;
}

export function getApiBaseUrl() {
  if (apiBaseUrlOverride) {
    return apiBaseUrlOverride;
  }

  if (typeof window !== 'undefined') {
    const queryValue = new URLSearchParams(window.location.search).get('apiBaseUrl');
    if (queryValue) {
      return queryValue;
    }
  }

  return getElectronApiBaseUrl() ?? DEFAULT_API_BASE_URL;
}

export function buildApiUrl(path: string) {
  return `${getApiBaseUrl()}${path}`;
}

async function fetchJson<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(buildApiUrl(path), init);

  if (!response.ok) {
    let message = `HTTP ${response.status}`;

    try {
      const payload = await response.json();
      if (typeof payload?.detail === 'string') {
        message = payload.detail;
      }
    } catch {
      try {
        const text = await response.text();
        if (text) {
          message = text;
        }
      } catch {
        // ignore fallback parsing errors
      }
    }

    throw new ApiError(message, response.status);
  }

  return response.json() as Promise<T>;
}

export function fetchEngineHealth() {
  return fetchJson<{ status: string }>('/health', { method: 'GET' });
}

export function fetchProjectList() {
  return fetchJson<Project[]>('/projects', { method: 'GET' });
}

export function fetchProjectOverview(projectId: string) {
  return fetchJson<ProjectOverview>(`/projects/${projectId}`, { method: 'GET' });
}

export function fetchProjectMetadataConfirmation(projectId: string) {
  return fetchJson<ProjectMetadataConfirmation>(`/projects/${projectId}/metadata`, { method: 'GET' });
}

export function saveProjectMetadataConfirmation(projectId: string, payload: ProjectMetadataConfirmationUpdate) {
  return fetchJson<ProjectMetadataSaveResult>(`/projects/${projectId}/metadata`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

export async function saveProofreadBlock(projectId: string, blockId: string, text: string) {
  const result = await fetchJson<{ item: ProofreadBlock }>(`/proofread/${projectId}/blocks/${blockId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });

  return result.item;
}

export function fetchProofreadWorkspace(projectId: string) {
  return fetchJson<ProofreadWorkspace>(`/proofread/${projectId}/workspace`, { method: 'GET' });
}

export function fetchQualityStatus(projectId: string) {
  return fetchJson<QualityStatus>(`/quality/${projectId}`, { method: 'GET' });
}

export async function fetchExportOptions(projectId: string) {
  const result = await fetchJson<{ options: ExportOption[] }>(`/export/${projectId}/options`, { method: 'GET' });
  return result.options;
}

export function runExportOption(projectId: string, optionId: string) {
  return fetchJson<{ path: string }>(`/export/${projectId}/${optionId}`, { method: 'POST' });
}

export function getProjectNameFromPdfFileName(fileName: string) {
  return fileName.replace(/\.pdf$/i, '');
}

export function getProjectNameFromPdfPath(pdfPath: string) {
  const decodedPath = decodeURIComponent(pdfPath);
  const fileName = decodedPath.split(/[\\/]/).pop() ?? decodedPath;
  return getProjectNameFromPdfFileName(fileName);
}

export async function createProject(name: string) {
  return fetchJson<{ project_id: string; name: string; current_stage: string }>('/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
}

export async function uploadProjectSourcePdf(projectId: string, file: File) {
  return fetchJson<{ pdf_path: string }>(
    `/projects/${projectId}/source-pdf?filename=${encodeURIComponent(file.name)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: file
    }
  );
}

export async function startRecognition(projectId: string, pdfPath: string) {
  return fetchJson<RecognitionTask>(`/tasks/${projectId}/recognition/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pdf_path: pdfPath })
  });
}

export async function selectPdf() {
  if (typeof window !== 'undefined' && window.jojoPress?.selectPdf) {
    return window.jojoPress.selectPdf();
  }

  return null;
}

export async function getProjects() {
  return fetchProjectList();
}

export async function getProject(projectId: string) {
  return fetchProjectOverview(projectId);
}

export async function getMetadata(projectId: string) {
  return fetchProjectMetadataConfirmation(projectId);
}

export async function saveMetadata(projectId: string, payload: ProjectMetadataConfirmationUpdate) {
  return saveProjectMetadataConfirmation(projectId, payload);
}

export async function getProofreadWorkspace(projectId: string) {
  return fetchProofreadWorkspace(projectId);
}

export async function getRecognitionStatus(projectId: string) {
  return fetchJson<RecognitionTask | null>(`/tasks/${projectId}/recognition/status`, { method: 'GET' });
}

export async function selectPdfFileFromBrowser() {
  return new Promise<File | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,.pdf';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = () => {
      const file = input.files?.[0] ?? null;
      input.remove();
      resolve(file);
    };
    input.click();
  });
}

export async function resolvePdfSelection() {
  if (typeof window !== 'undefined' && window.jojoPress?.selectPdf) {
    return { kind: 'path' as const, value: await window.jojoPress.selectPdf() };
  }

  const file = await selectPdfFileFromBrowser();
  return { kind: 'file' as const, value: file };
}
