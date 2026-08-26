import { discoverHtmlListing, sectionUrl } from "../../discovery/html-listing.js";
import type { RouteDiscoveryEndpoint, SourceConfig } from "../../types.js";

type Endpoint = RouteDiscoveryEndpoint;

const articlePrefixes: Record<string, string[]> = {
  politics: ["/politics/"],
  world: ["/world/"],
  fortune: ["/fortune/"],
  comments: ["/comments/"],
  "hong-kong-macao": ["/gangao/"],
  taiwan: ["/tw/"],
  military: ["/mil/", "/milpro/"],
  law: ["/law/"],
  finance: ["/money/"],
};

export function discoverXinhua(source: SourceConfig, endpoint: Endpoint, fetchedAt: string) {
  const prefixes = articlePrefixes[endpoint.route];
  if (!prefixes) throw new Error(`${source.id}: unsupported route: ${endpoint.route}`);
  return discoverHtmlListing(source, fetchedAt, {
    listingUrl: sectionUrl(source, endpoint.route),
    articlePathPrefixes: prefixes,
    maximumItems: endpoint.maximumItems,
    bodySelectors: ["#detailContent"],
    publicationDateSelectors: ["#pubtime_baidu", ".header-time", ".mheader .info"],
    version: "xinhua-html/1",
  });
}
