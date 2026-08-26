import { discoverHtmlListing, sectionUrl } from "../../discovery/html-listing.js";
import type { RouteDiscoveryEndpoint, SourceConfig } from "../../types.js";

type Endpoint = RouteDiscoveryEndpoint;

export function discoverAfricanews(source: SourceConfig, endpoint: Endpoint, fetchedAt: string) {
  if (endpoint.route !== "markets") throw new Error(`${source.id}: unsupported route: ${endpoint.route}`);
  return discoverHtmlListing(source, fetchedAt, {
    listingUrl: sectionUrl(source, endpoint.route),
    articlePathPrefixes: ["/202"],
    maximumItems: endpoint.maximumItems,
    bodySelectors: [".article__body", ".article-body"],
    version: "africanews-html/1",
  });
}
