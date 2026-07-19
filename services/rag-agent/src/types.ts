export interface DocumentRecord {
  id: string;
  title: string;
  originalName: string;
  storedName: string;
  sizeBytes: number;
  lineCount: number;
  createdAt: string;
}

export type PublicDocument = Omit<DocumentRecord, "storedName">;

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequestBody {
  question: string;
  documentIds: string[];
  history?: ChatHistoryMessage[];
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

export interface SearchHit {
  documentId: string;
  documentTitle: string;
  startLine: number;
  endLine: number;
  matchedQueries: string[];
  excerpt: string;
}
