export type ProofreadIssueKind = 'heading_level_review';

export type ProofreadIssueSeverity = 'low' | 'medium' | 'high';

export interface ProofreadIssue {
  id: string;
  kind: ProofreadIssueKind;
  severity: ProofreadIssueSeverity;
  blockId: string;
  message: string;
}

export interface BlockBbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageBlock {
  id?: string;
  type?: string;
  text: string;
  bbox?: BlockBbox;
  level?: number;
}

export interface PageData {
  pageNum: number;
  content?: string;
  blocks?: PageBlock[];
  imageUrl?: string;
  pdfPageUrl?: string;
}

export interface PdfPreviewData {
  page: number;
  documentUrl?: string;
  pages?: PageData[];
  totalPages?: number;
  fullText?: string;
  originalPdfUrl?: string;
  pageImages?: string[];
}

export type ProofreadBlockKind = 'heading' | 'body' | 'footnote' | 'caption';

export type ProofreadFontWeight = 'regular' | 'medium' | 'bold';

export interface ProofreadBlock {
  id: string;
  text: string;
  pageNumber?: number;
  bbox?: BlockBbox;
  kind?: ProofreadBlockKind;
  fontSize?: number;
  fontWeight?: ProofreadFontWeight;
  checked?: boolean;
  label?: string;
  originalText?: string;
}

export type ProofreadWorkspaceStatus = 'ready' | 'pending' | 'recognition_pending';

export interface TocTreeItem {
  id?: string;
  label?: string;
  title?: string;
  page?: number;
}

export interface NonTextRegion {
  id: string;
  pageNumber: number;
  kind: 'image';
  label: string;
  bbox: BlockBbox;
}

export interface AutosaveState {
  status: 'idle' | 'saving' | 'saved' | 'error';
  message: string;
}

export interface ProofreadWorkspace {
  status: ProofreadWorkspaceStatus;
  notice: string | null;
  issues: ProofreadIssue[];
  preview: PdfPreviewData;
  block: ProofreadBlock | null;
  toc: TocTreeItem[];
  documentTitle?: string;
  blocks?: ProofreadBlock[];
  selectedBlockId?: string | null;
  checkedCount?: number;
  totalBlocks?: number;
  autosave?: AutosaveState;
  nonTextRegions?: NonTextRegion[];
}
