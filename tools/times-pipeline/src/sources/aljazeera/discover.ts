import { discoverHtmlListing, sectionUrl } from "../../discovery/html-listing.js";
import type { RouteDiscoveryEndpoint, SourceConfig } from "../../types.js";

type AlJazeeraDiscoveryEndpoint = RouteDiscoveryEndpoint;

const routes = new Set([
  "news", "africa", "asia", "us-canada", "latin-america", "europe", "asia-pacific",
  "middle-east", "explained", "economy", "human-rights",
]);

export function discoverAlJazeera(source: SourceConfig, endpoint: AlJazeeraDiscoveryEndpoint, fetchedAt: string) {
  if (!routes.has(endpoint.route)) throw new Error(`${source.id}: unsupported route: ${endpoint.route}`);
  return discoverHtmlListing(source, fetchedAt, {
    listingUrl: sectionUrl(source, endpoint.route),
    articlePathPrefixes: endpoint.route === "economy"
      ? ["/economy/", "/news/", "/features/"]
      : ["/news/", "/features/"],
    linkSelector: ".u-clickable-card__link[href]",
    maximumItems: endpoint.maximumItems,
    bodySelectors: [".wysiwyg", ".article-p-wrapper", ".article__body"],
    version: "aljazeera-html/1",
  });
}
