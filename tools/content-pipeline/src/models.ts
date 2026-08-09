import type {
  JojoAnnotation,
  JojoCanonicalAsset,
  JojoCanonicalChapter,
  JojoTocNode,
} from "@jojo/content";

export interface WereadTocEntry {
  chapterUid?: number | string;
  chapterIdx?: number;
  updateTime?: number;
  title?: string;
  wordCount?: number;
  level?: number;
  files?: string[];
  anchors?: Array<{ title?: string; level?: number; anchor?: string }>;
}

export type WereadChapterRecord = Record<string, unknown> & { cid?: string };

export interface WereadRawExport {
  bid?: string;
  bookId?: string | number;
  toc?: WereadTocEntry[];
  meta?: Record<string, unknown>;
  chapters?: WereadChapterRecord[];
  site?: string;
  date?: number | string;
}

export interface DecodedWereadChapter {
  id: string;
  sourceCid: string;
  sourceChapterUid?: string;
  sourceFiles: string[];
  title: string;
  order: number;
  level: number;
  contentType: "application/xhtml+xml" | "text/plain";
  content: string;
}

export interface DecodedWereadBook {
  sourcePath: string;
  sourceSha256: string;
  sourceBookId: string;
  sourceBid?: string;
  exportedAt: string;
  metadata: Record<string, unknown>;
  title: string;
  author: string;
  publisher: string;
  isbn: string;
  language: string;
  description: string;
  coverUrl?: string;
  publishedDate?: string;
  chapters: DecodedWereadChapter[];
  toc: JojoTocNode[];
  diagnostics: {
    sourceTocItems: number;
    sourceChapterRecords: number;
    matchedChapterRecords: number;
    decodedChapterRecords: number;
    failedChapterRecords: number;
    errors: Array<Record<string, unknown>>;
  };
}

export interface NormalizedBookPart {
  datasetId: string;
  datasetTitle: string;
  datasetType: "book" | "book-series";
  itemId: string;
  itemKey: string;
  itemType: "book" | "book-volume";
  itemTitle: string;
  itemOrder: number;
  volumeNumber?: number;
  totalVolumes?: number;
  source: DecodedWereadBook;
  chapters: JojoCanonicalChapter[];
  toc: JojoTocNode[];
  assets: JojoCanonicalAsset[];
  annotations: JojoAnnotation[];
}

export interface PipelineDiagnostic {
  level: "error" | "warning";
  code: string;
  message: string;
  source?: string;
  itemId?: string;
}

export interface BuiltItemSummary {
  datasetId: string;
  datasetTitle: string;
  itemId: string;
  itemKey: string;
  itemTitle: string;
  chapters: number;
  characters: number;
  assets: number;
  annotations: number;
  manifestObject: string;
  canonicalObject: string;
}

export interface PipelineReport {
  formatVersion: "jojo-pipeline-report/1";
  generatedAt: string;
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
  outputDirectory: string;
  catalogObject: string;
  itemsBuilt: BuiltItemSummary[];
  diagnostics: PipelineDiagnostic[];
}
