export interface ProjectMetadataConfirmation {
  id: string;
  title: string;
  subtitle?: string | null;
  authors?: string[];
  language: string;
  coverAssetId: string | null;
}

export interface ProjectMetadataConfirmationUpdate {
  title: string;
  subtitle?: string | null;
  authors: string[];
  language: string;
  coverAssetId: string | null;
}

export interface ProjectMetadataSaveResult extends ProjectMetadataConfirmation {
  currentStage: string;
}

export interface ProjectOverview {
  id: string;
  title: string;
  currentStage: string;
}

export interface QualityStatus {
  status: 'blocked' | 'passed';
  checks: string[];
}

export interface ExportOption {
  id: string;
  label: string;
}

export type MockWorkflowStatus = 'recognizing' | 'metadata_review' | 'proofreading' | 'structured' | 'export_ready';

export interface MockTaskSummary {
  id: string;
  title: string;
  currentStep: string;
  progressPercent: number;
  progressLabel: string;
  updatedAt: string;
  nextHref: string;
  ctaLabel: string;
  tone: 'active' | 'ready' | 'complete';
}

export interface MockRecognitionState {
  projectId: string;
  title: string;
  fileName: string;
  engine: string;
  totalPages: number;
  processedPages: number;
  currentPhase: string;
  statusText: string;
  estimateLabel: string;
  nextHref: string;
}

export interface MockCoverCandidate {
  pageNumber: number;
  label: string;
  excerpt: string;
}

export interface MockMetadataDraft extends ProjectMetadataConfirmation {
  authorsText: string;
  sourceFileName: string;
  confidenceNote: string;
  coverCandidates: MockCoverCandidate[];
  nextHref: string;
}

export interface MockStructuredOutputSection {
  id: string;
  label: string;
  count: number;
  description: string;
}

export interface MockStructuredOutputPreview {
  title: string;
  summary: string[];
  sections: MockStructuredOutputSection[];
  exportHref: string;
}

export interface MockExportTarget {
  id: string;
  label: string;
  description: string;
  primary?: boolean;
}

export interface MockExportPlan {
  title: string;
  destination: string;
  targets: MockExportTarget[];
}
