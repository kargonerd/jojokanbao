import { discoverHtmlListing, sectionUrl } from "../../discovery/html-listing.js";
import type { RouteDiscoveryEndpoint, SourceConfig } from "../../types.js";
import { peopleFetch } from "./fetch.js";

type Endpoint = RouteDiscoveryEndpoint;

const routes = new Set([
  "politics", "personnel", "anti-corruption", "theory", "economy-technology",
  "society-law", "world", "military", "greater-bay-area", "taiwan",
]);

export function discoverPeople(source: SourceConfig, endpoint: Endpoint, fetchedAt: string) {
  if (!routes.has(endpoint.route)) throw new Error(`${source.id}: unsupported route: ${endpoint.route}`);
  const url = new URL(sectionUrl(source, endpoint.route));
  url.protocol = "http:";
  return discoverHtmlListing(source, fetchedAt, {
    listingUrl: url.href,
    articlePathPrefixes: ["/n1/"],
    maximumItems: endpoint.maximumItems,
    bodySelectors: peopleFetch.bodySelectors,
    publicationDateSelectors: ["#newstime", "#pubtime_baidu", ".pubtime", ".content_left_time", ".mheader .info"],
    publicationDateMode: "wall-clock",
    version: "people-html/1",
  });
}
