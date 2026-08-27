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

export interface SourceFetchPolicy {
  capture: "browser" | "http";
  captureUrl?: "canonical" | "source";
  bodySelectors: string[];
}

export type UnavailablePageReason = "UnsupportedMedia" | "HardPaywall";

export interface PageAvailabilityInput {
  title: string;
  url: string;
  html?: string;
  hasFullBody: boolean;
}

export type RouteSourceAdapter =
  | "africanews"
  | "agencia-brasil"
  | "aljazeera"
  | "chinanews"
  | "cna"
  | "people"
  | "thepaper"
  | "xinhua"
  | "zaobao";

export interface RouteDiscoveryEndpoint {
  kind: "source-adapter";
  adapter: RouteSourceAdapter;
  driver: DiscoveryDriver;
  route: string;
  maximumItems: number;
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
      adapter: "nikkei";
      driver: DiscoveryDriver;
      route: string;
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
  | RouteDiscoveryEndpoint
  | { kind: "official-rss"; url: string }
  | { kind: "official-rss-list"; urls: string[] }
  | { kind: "sitemap"; url: string; maximumPages: number };

export interface DiscoveryTarget {
  id: string;
  sectionIds: string[];
  fallback?: boolean;
  discovery: DiscoveryEndpoint;
}

export type DiscoveryConfig = DiscoveryEndpoint | { kind: "multi"; targets: DiscoveryTarget[] };

export interface PublisherSectionConfig {
  id: string;
  name: string;
  url: string;
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

export type ContentPriority = "discovery-body" | "captured-page" | "discovery-summary";

export type PageFetchStrategy = "direct-first" | "browser-first";

export interface CapturedAsset {
  id: string;
  type: "image";
  role: "lead" | "content";
  sourceUrl: string;
  rawObject: string;
  mediaType: string;
  size: number;
  sha256: string;
  alt?: string;
  caption?: string;
  credit?: string;
  width?: number;
  height?: number;
}

export interface SourceConfig {
  id: string;
  name: string;
  language: string;
  publicationTimeZone: string;
  sections?: PublisherSectionConfig[];
  discovery: DiscoveryConfig;
  content: {
    priority: ContentPriority[];
    parser?: string;
    minimumFullCharacters?: number;
    minimumFullParagraphs?: number;
  };
  fetch: {
    strategy: PageFetchStrategy;
    bpc: boolean;
    browser?: "chromium" | "brave";
    retryWithoutBpcOnBlocked?: boolean;
    proxyPolicy?: "none" | "rotate";
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
  capturedAt?: string;
  captureHttpStatus?: number;
  rawPageObject?: string;
  captureStatus?: "pending" | "captured" | "unchanged" | "failed" | "hard-paywall" | "skipped";
  captureMethod?: "direct" | "browser";
  assets?: CapturedAsset[];
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
  transport: "source-adapter" | "official-rss" | "official-rss-list" | "sitemap" | "multi";
  fetchedAt: string;
  upstream: unknown;
  candidates: Candidate[];
  version?: string;
  fetchPolicy?: SourceFetchPolicy;
  window?: {
    startInclusive: string;
    endInclusive: string;
    futureToleranceSeconds: number;
    discovered: number;
    accepted: number;
    beforeWindow: number;
    afterWindow: number;
    invalidTimestamp: number;
    anomalies: Array<{
      articleId: string;
      title: string;
      canonicalUrl: string;
      publishedAt: string;
      reason: "after-window" | "invalid-timestamp";
    }>;
  };
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
  formatVersion: "jojo-times-raw-source-run/2";
  runId: string;
  sourceId: string;
  sourceName: string;
  publicationTimeZone: string;
  startedAt: string;
  completedAt: string;
  discovery: SourceConfig["discovery"];
  candidateCount: number;
  fullCount: number;
  summaryCount: number;
  metadataCount: number;
  networkExchangeCount: number;
  window?: NonNullable<DiscoveryResult["window"]>;
  fetchPolicy?: SourceFetchPolicy;
  sectionCoverage?: {
    selected: string[];
    covered: string[];
    uncovered: string[];
    failedTargets: string[];
    fallbackUsed: boolean;
  };
  objects: Array<{ path: string; size: number; sha256: string }>;
  captureStatus: "discovery-complete" | "pages-complete";
  pageCapture?: {
    planned: number;
    captured: number;
    unchanged: number;
    failed: number;
    skipped: number;
    hardPaywall: number;
    direct: number;
    browser: number;
    assets: number;
  };
  healthStatus: "healthy" | "degraded" | "empty";
  complete: boolean;
}
