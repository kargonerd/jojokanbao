import { discoverHtmlListing, sectionUrl } from "../../discovery/html-listing.js";
import type { RouteDiscoveryEndpoint, SourceConfig } from "../../types.js";

type Endpoint = RouteDiscoveryEndpoint;

export function discoverCna(source: SourceConfig, endpoint: Endpoint, fetchedAt: string) {
  if (endpoint.route !== "top-stories") throw new Error(`${source.id}: unsupported route: ${endpoint.route}`);
  return discoverHtmlListing(source, fetchedAt, {
    listingUrl: sectionUrl(source, endpoint.route),
    articlePathPrefixes: ["/asia/", "/east-asia/", "/singapore/", "/world/", "/business/"],
    maximumItems: endpoint.maximumItems,
    bodySelectors: [".text-long", ".article-content"],
    version: "cna-html/1",
  });
}
