import type {
  BrowserDiscoveryRuntime,
  Candidate,
  DiscoveryEndpoint,
  DiscoveryResult,
  PageAvailabilityInput,
  SourceConfig,
  SourceFetchPolicy,
  UnavailablePageReason,
} from "../types.js";
import type { ArticleBodyExtractor } from "../content/body.js";
import type { ArticleImageExtractor } from "../capture/page-images.js";
import type { CapturedHtmlPage } from "../capture/http.js";

export type SourceAdapterEndpoint = Extract<DiscoveryEndpoint, { kind: "source-adapter" }>;

export type StaleCanonicalRemovalReason = "stale-publisher-access-offer";

/**
 * Source-owned classifier for content already persisted in Canonical. The
 * shared writer only invokes this after the current publisher extractor has
 * terminally rejected an access-offer page, so the hook cannot turn ordinary
 * capture failures into retractions.
 */
export type StaleCanonicalBodyClassifier = (
  previousBodyHtml: string,
) => StaleCanonicalRemovalReason | undefined;

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
  extractBody?: ArticleBodyExtractor;
  extractImages?: ArticleImageExtractor;
  classifyStaleCanonicalBody?: StaleCanonicalBodyClassifier;
  classifyUnavailable?(
    input: PageAvailabilityInput,
    source: SourceConfig,
  ): UnavailablePageReason | undefined;
  acceptUrl?(url: string): boolean;
  accept?(candidate: Candidate): boolean;
  process?(candidate: Candidate): Candidate;
}
