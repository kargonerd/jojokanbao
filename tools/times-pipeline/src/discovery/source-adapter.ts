import { discoverAp } from "./adapters/ap.js";
import type {
  BrowserDiscoveryRuntime,
  DiscoveryEndpoint,
  DiscoveryResult,
  DiscoveryRuntime,
  SourceConfig,
} from "../types.js";

type SourceAdapterEndpoint = Extract<DiscoveryEndpoint, { kind: "source-adapter" }>;

interface SourceDiscoveryAdapter {
  http?: (
    source: SourceConfig,
    endpoint: SourceAdapterEndpoint,
    fetchedAt: string,
  ) => Promise<DiscoveryResult>;
  browser?: (
    source: SourceConfig,
    endpoint: SourceAdapterEndpoint,
    fetchedAt: string,
    browser: BrowserDiscoveryRuntime,
  ) => Promise<DiscoveryResult>;
}

const adapters: Record<SourceAdapterEndpoint["adapter"], SourceDiscoveryAdapter> = {
  ap: { http: discoverAp },
};

export async function discoverWithSourceAdapter(
  source: SourceConfig,
  fetchedAt: string,
  runtime: DiscoveryRuntime = {},
): Promise<DiscoveryResult> {
  if (source.discovery.kind !== "source-adapter") {
    throw new Error(`${source.id}: expected source-adapter discovery`);
  }
  const endpoint = source.discovery;
  const adapter = adapters[endpoint.adapter];
  if (endpoint.driver === "http") {
    if (!adapter.http) throw new Error(`${source.id}: ${endpoint.adapter} does not support HTTP discovery`);
    return adapter.http(source, endpoint, fetchedAt);
  }
  if (!runtime.browser) throw new Error(`${source.id}: browser discovery runtime is not configured`);
  if (!adapter.browser) throw new Error(`${source.id}: ${endpoint.adapter} does not support browser discovery`);
  return adapter.browser(source, endpoint, fetchedAt, runtime.browser);
}
