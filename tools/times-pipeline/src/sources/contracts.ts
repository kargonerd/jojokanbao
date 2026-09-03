import type {
  BrowserDiscoveryRuntime,
  Candidate,
  CapturedAsset,
  DiscoveryEndpoint,
  DiscoveryResult,
  PageAvailabilityInput,
  SourceConfig,
  SourceFetchPolicy,
  UnavailablePageReason,
} from "../types.js";
import type { ArticleBodyExtractor, OriginalPageRejectionClassifier } from "../content/body.js";
import type { ArticleImageExtractor } from "../capture/page-images.js";
import type { CapturedHtmlPage } from "../capture/http.js";

export type SourceAdapterEndpoint = Extract<DiscoveryEndpoint, { kind: "source-adapter" }>;

export type StaleCanonicalRemovalReason = "stale-publisher-access-offer";

export interface PublisherArticleTimestamps {
  publishedAt: string;
  updatedAt?: string;
}

export type PublisherArticleTimestampsExtractor = (
  html: string,
  pageUrl?: string,
) => PublisherArticleTimestamps | undefined;

/**
 * Source-owned classifier for content already persisted in Canonical. The
 * shared writer only invokes this after the current publisher extractor has
 * terminally rejected an access-offer page, so the hook cannot turn ordinary
 * capture failures into retractions.
 */
export type StaleCanonicalBodyClassifier = (
  previousBodyHtml: string,
) => StaleCanonicalRemovalReason | undefined;

/**
 * Source-owned validation for both newly captured and retained Canonical
 * assets. Keeping this hook at the source boundary lets extraction-policy
 * upgrades clean historical articles that are no longer present in the
 * publisher's current discovery window.
 */
export type CanonicalAssetAcceptor = (asset: CapturedAsset) => boolean;

export interface SourceModule {
  id: string;
  discoverHttp?: (
    source: SourceConfig,
    endpoint: SourceAdapterEndpoint,
    fetchedAt: string,
  ) => Promise<DiscoveryResult>;
  discoverBrowser?: (
    source: SourceConfig,
    endpoint: SourceAdapterEndpoint,
    fetchedAt: string,
    browser: BrowserDiscoveryRuntime,
  ) => Promise<DiscoveryResult>;
  fetch?: SourceFetchPolicy;
  capturePage?: (url: string, timeoutSeconds: number) => Promise<CapturedHtmlPage | undefined>;
  extractTimestamps?: PublisherArticleTimestampsExtractor;
  extractBody?: ArticleBodyExtractor;
  classifyOriginalPageRejection?: OriginalPageRejectionClassifier;
  extractImages?: ArticleImageExtractor;
  acceptCanonicalAsset?: CanonicalAssetAcceptor;
  classifyStaleCanonicalBody?: StaleCanonicalBodyClassifier;
  classifyUnavailable?(
    input: PageAvailabilityInput,
    source: SourceConfig,
  ): UnavailablePageReason | undefined;
  acceptUrl?(url: string): boolean;
  accept?(candidate: Candidate): boolean;
  process?(candidate: Candidate): Candidate;
}
