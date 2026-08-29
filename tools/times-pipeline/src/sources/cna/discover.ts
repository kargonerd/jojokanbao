import { discoverHtmlListing, sectionUrl } from "../../discovery/html-listing.js";
import type { RouteDiscoveryEndpoint, SourceConfig } from "../../types.js";
import { cnaFetch } from "./fetch.js";

type CnaDiscoveryEndpoint = RouteDiscoveryEndpoint;

export function discoverCna(source: SourceConfig, endpoint: CnaDiscoveryEndpoint, fetchedAt: string) {
  if (endpoint.route !== "top-stories") throw new Error(`${source.id}: unsupported route: ${endpoint.route}`);
  return discoverHtmlListing(source, fetchedAt, {
    listingUrl: sectionUrl(source, endpoint.route),
    articlePathPrefixes: ["/asia/", "/east-asia/", "/singapore/", "/world/", "/business/"],
    maximumItems: endpoint.maximumItems,
    bodySelectors: cnaFetch.bodySelectors,
    version: "cna-html/2",
  });
}
