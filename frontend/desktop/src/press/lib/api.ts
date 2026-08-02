import type {
  ExportOption,
  ProjectMetadataConfirmation,
  ProjectMetadataConfirmationUpdate,
  ProjectMetadataSaveResult,
  ProjectOverview,
  QualityStatus
} from '../types/project';
import type { ProofreadBlock, ProofreadWorkspace } from '../types/issues';

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

function getDesktopBridge() {
  return typeof window !== 'undefined' ? window.jojoDesktop : undefined;
}

function requireDesktopBridge() {
  const bridge = getDesktopBridge();
  if (!bridge) throw new ApiError('Press 只能在 JOJO 桌面应用中运行', 503);
  return bridge;
}

async function invokeDesktop<T>(command: string, payload: Record<string, unknown> = {}) {
  const result = await requireDesktopBridge().engine.invoke(command, payload);
  if (!result.ok) throw new ApiError(result.error.message, result.error.status);
  return result.value as T;
}

export function fetchEngineHealth() {
  return invokeDesktop<{ status: string }>('health');
}

export function fetchProjectList() {
  return invokeDesktop<Project[]>('projects:list');
}

export function fetchProjectOverview(projectId: string) {
  return invokeDesktop<ProjectOverview>('projects:get', { projectId });
}

export function fetchProjectMetadataConfirmation(projectId: string) {
  return invokeDesktop<ProjectMetadataConfirmation>('projects:metadata:get', { projectId });
}

export function saveProjectMetadataConfirmation(projectId: string, payload: ProjectMetadataConfirmationUpdate) {
  return invokeDesktop<ProjectMetadataSaveResult>('projects:metadata:save', { projectId, ...payload });
}

export async function saveProofreadBlock(projectId: string, blockId: string, text: string) {
  const result = await invokeDesktop<{ item: ProofreadBlock }>('proofread:block:save', { projectId, blockId, text });
  return result.item;
}

export function fetchProofreadWorkspace(projectId: string) {
  return invokeDesktop<ProofreadWorkspace>('proofread:workspace', { projectId });
}

export function fetchQualityStatus(projectId: string) {
  return invokeDesktop<QualityStatus>('quality:get', { projectId });
}

export async function fetchExportOptions(projectId: string) {
  const result = await invokeDesktop<{ options: ExportOption[] }>('export:options', { projectId });
  return result.options;
}

export function runExportOption(projectId: string, optionId: string) {
  return invokeDesktop<{ path: string }>('export:run', { projectId, optionId });
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
  return invokeDesktop<{ project_id: string; name: string; current_stage: string }>('projects:create', { name });
}

export function importProjectSourcePdf(projectId: string, sourcePath: string) {
  return invokeDesktop<{ pdf_path: string }>('projects:source:import', {
    projectId,
    sourcePath,
  });
}

export async function startRecognition(projectId: string, pdfPath: string) {
  return invokeDesktop<RecognitionTask>('recognition:start', { projectId, pdfPath });
}

export async function selectPdf() {
  return requireDesktopBridge().selectPdf?.() ?? null;
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
  return invokeDesktop<RecognitionTask | null>('recognition:status', { projectId });
}

export async function resolvePdfSelection() {
  return { kind: 'path' as const, value: await selectPdf() };
}
