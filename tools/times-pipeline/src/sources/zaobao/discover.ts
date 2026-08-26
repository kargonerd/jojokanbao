import { discoverHtmlListing } from "../../discovery/html-listing.js";
import type { RouteDiscoveryEndpoint, SourceConfig } from "../../types.js";

type Endpoint = RouteDiscoveryEndpoint;

const routes: Record<string, { url: string; prefixes: string[] }> = {
  "latest-china": { url: "https://www.zaobao.com/realtime/china", prefixes: ["/realtime/", "/news/"] },
  "latest-singapore": { url: "https://www.zaobao.com/realtime/singapore", prefixes: ["/realtime/", "/news/"] },
  "latest-world": { url: "https://www.zaobao.com/realtime/world", prefixes: ["/realtime/", "/news/"] },
  "latest-finance": { url: "https://www.zaobao.com/realtime/finance", prefixes: ["/realtime/", "/finance/"] },
  "southeast-asia": { url: "https://www.zaobao.com/news/sea", prefixes: ["/news/", "/realtime/"] },
};

export function discoverZaobao(source: SourceConfig, endpoint: Endpoint, fetchedAt: string) {
  const route = routes[endpoint.route];
  if (!route) throw new Error(`${source.id}: unsupported route: ${endpoint.route}`);
  return discoverHtmlListing(source, fetchedAt, {
    listingUrl: route.url,
    articlePathPrefixes: route.prefixes,
    linkSelector: ".card-listing .card .content-header a[href], [data-testid='article-list'] article a.article-link[href]",
    maximumItems: endpoint.maximumItems,
    bodySelectors: [".article-content-rawhtml", ".article-body"],
    version: "zaobao-html/1",
  });
}
