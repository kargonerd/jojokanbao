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

export type SourceAdapterEndpoint = Extract<DiscoveryEndpoint, { kind: "source-adapter" }>;

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
  extractBody?: ArticleBodyExtractor;
  classifyUnavailable?(
    input: PageAvailabilityInput,
    source: SourceConfig,
  ): UnavailablePageReason | undefined;
  accept?(candidate: Candidate): boolean;
  process?(candidate: Candidate): Candidate;
}
