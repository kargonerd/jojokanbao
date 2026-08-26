import { discoverHtmlListing, sectionUrl } from "../../discovery/html-listing.js";
import type { RouteDiscoveryEndpoint, SourceConfig } from "../../types.js";

type Endpoint = RouteDiscoveryEndpoint;

const articlePrefixes: Record<string, string[]> = {
  latest: ["/gn/", "/cj/", "/gj/", "/sh/"],
  politics: ["/gn/"],
  finance: ["/cj/"],
  world: ["/gj/"],
  society: ["/sh/"],
};

export function discoverChinanews(source: SourceConfig, endpoint: Endpoint, fetchedAt: string) {
  const prefixes = articlePrefixes[endpoint.route];
  if (!prefixes) throw new Error(`${source.id}: unsupported route: ${endpoint.route}`);
  return discoverHtmlListing(source, fetchedAt, {
    listingUrl: sectionUrl(source, endpoint.route),
    articlePathPrefixes: prefixes,
    maximumItems: endpoint.maximumItems,
    bodySelectors: [".left_zw", ".content_desc"],
    publicationDateSelectors: ["#pubtime_baidu", ".pubtime", ".content_left_time"],
    version: "chinanews-html/1",
  });
}
