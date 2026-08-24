export type DiscoveryConfig =
  | { kind: "rsshub-package"; route: string }
  | { kind: "official-rss"; url: string }
  | { kind: "official-rss-list"; urls: string[] }
  | { kind: "sitemap"; url: string; maximumPages: number }
  | { kind: "site-adapter"; adapter: string };

export type ContentPriority = "discovery-body" | "browser-parser" | "discovery-summary";

export interface SourceConfig {
  id: string;
  name: string;
  language: string;
  discovery: DiscoveryConfig;
  content: {
    priority: ContentPriority[];
    parser?: string;
    minimumFullCharacters?: number;
    minimumFullParagraphs?: number;
    allowedHostnames?: string[];
    excludedPathPrefixes?: string[];
  };
  archive: {
    mode: "browser" | "http" | "none";
    bpc: boolean;
    proxyPolicy?: string;
  };
  health: {
    minimumCandidates: number;
  };
  enabled: boolean;
}

export interface Candidate {
  articleId: string;
  sourceId: string;
  sourceName: string;
  language: string;
  sourceUrl: string;
  canonicalUrl: string;
  title: string;
  summary?: string;
  discoveryBody?: string;
  browserBody?: string;
  browserCapturedAt?: string;
  browserHttpStatus?: number;
  browserArchiveObject?: string;
  browserFailureReason?: "hard-paywall" | "http-blocked" | "extraction-failed";
  contentStatus: "full" | "summary" | "metadata";
  publishedAt: string;
  updatedAt?: string;
  authors: string[];
  publisherCategories: string[];
  upstreamId?: string;
}

export interface DiscoveryResult {
  source: SourceConfig;
  transport: "rsshub-package" | "official-rss" | "official-rss-list" | "sitemap" | "site-adapter";
  fetchedAt: string;
  upstream: unknown;
  candidates: Candidate[];
  version?: string;
}

export interface RecordedExchange {
  sequence: number;
  startedAt: string;
  finishedAt: string;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  response?: {
    status: number;
    url: string;
    headers: Record<string, string>;
    bodyObject?: string;
    bodySha256?: string;
    bodyBytes?: number;
    storedBytes?: number;
    truncated?: boolean;
  };
  error?: string;
}

export interface SourceCaptureManifest {
  formatVersion: "jojo-times-raw-source-run/1";
  runId: string;
  sourceId: string;
  sourceName: string;
  startedAt: string;
  completedAt: string;
  discovery: SourceConfig["discovery"];
  candidateCount: number;
  fullCount: number;
  summaryCount: number;
  metadataCount: number;
  networkExchangeCount: number;
  objects: Array<{ path: string; size: number; sha256: string }>;
  archiveStatus: "recorded-http" | "wacz-complete";
  healthStatus: "healthy" | "empty";
  complete: boolean;
}
