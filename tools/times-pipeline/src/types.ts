export type DiscoveryDriver = "http" | "browser";

export interface BrowserDiscoveryPage {
  url: string;
  status?: number;
  html: string;
}

export interface BrowserDiscoveryRuntime {
  open(url: string): Promise<BrowserDiscoveryPage>;
}

export interface DiscoveryRuntime {
  browser?: BrowserDiscoveryRuntime;
}

export interface SourcePagePolicy {
  capture: "browser" | "http";
  captureUrl?: "canonical" | "source";
  bodySelectors: string[];
  bodyExtractor?: "bloomberg-next-data";
}

export type DiscoveryEndpoint =
  | {
      kind: "source-adapter";
      adapter: "ap";
      driver: DiscoveryDriver;
      path: string;
      maximumItems: number;
    }
  | {
      kind: "source-adapter";
      adapter: "nikkei";
      driver: DiscoveryDriver;
      stream: "latest";
      maximumItems: number;
    }
  | {
      kind: "source-adapter";
      adapter: "cls";
      driver: DiscoveryDriver;
      categoryId: string;
      maximumItems: number;
    }
  | {
      kind: "source-adapter";
      adapter: "dw";
      driver: DiscoveryDriver;
      navigationId: string;
      maximumItems: number;
    }
  | { kind: "official-rss"; url: string }
  | { kind: "official-rss-list"; urls: string[] }
  | { kind: "sitemap"; url: string; maximumPages: number }
  | {
      kind: "site-adapter";
      adapter: "html-news-page";
      url: string;
      articlePathPrefixes: string[];
      linkSelector?: string;
      maximumItems: number;
    }
  | {
      kind: "site-adapter";
      adapter: "thepaper-channel";
      channelId: string;
      maximumItems: number;
    };

export interface DiscoveryTarget {
  id: string;
  sectionIds: string[];
  fallback?: boolean;
  discovery: DiscoveryEndpoint;
}

export type DiscoveryConfig = DiscoveryEndpoint | { kind: "multi"; targets: DiscoveryTarget[] };

export type PublisherSectionKind = "stream" | "edition" | "region" | "topic";

export interface PublisherSectionConfig {
  id: string;
  name: string;
  url: string;
  kind: PublisherSectionKind;
  discoverable?: boolean;
  match?: {
    urlPrefixes?: string[];
    publisherCategories?: string[];
  };
}

export interface PublisherSectionRef {
  id: string;
  name: string;
}

export type ContentPriority = "discovery-body" | "browser-parser" | "discovery-summary";

export interface SourceConfig {
  id: string;
  name: string;
  language: string;
  sections?: PublisherSectionConfig[];
  discovery: DiscoveryConfig;
  content: {
    priority: ContentPriority[];
    parser?: string;
    minimumFullCharacters?: number;
    minimumFullParagraphs?: number;
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
  contentStatus: "full" | "summary" | "metadata";
  publishedAt: string;
  updatedAt?: string;
  authors: string[];
  publisherCategories: string[];
  publisherSections?: PublisherSectionRef[];
  upstreamId?: string;
}

export interface DiscoveryResult {
  source: SourceConfig;
  transport: "source-adapter" | "official-rss" | "official-rss-list" | "sitemap" | "site-adapter" | "multi";
  fetchedAt: string;
  upstream: unknown;
  candidates: Candidate[];
  version?: string;
  pagePolicy?: SourcePagePolicy;
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
  pagePolicy?: SourcePagePolicy;
  sectionCoverage?: {
    selected: string[];
    covered: string[];
    uncovered: string[];
    failedTargets: string[];
    fallbackUsed: boolean;
  };
  objects: Array<{ path: string; size: number; sha256: string }>;
  archiveStatus: "recorded-http" | "wacz-complete";
  healthStatus: "healthy" | "degraded" | "empty";
  complete: boolean;
}
