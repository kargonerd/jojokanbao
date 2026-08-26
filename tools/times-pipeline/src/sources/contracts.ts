import type {
  BrowserDiscoveryRuntime,
  Candidate,
  DiscoveryEndpoint,
  DiscoveryResult,
  SourceConfig,
  SourceFetchPolicy,
} from "../types.js";

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
  accept?(candidate: Candidate): boolean;
  process?(candidate: Candidate): Candidate;
}
