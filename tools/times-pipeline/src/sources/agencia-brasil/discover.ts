import { discoverHtmlListing, sectionUrl } from "../../discovery/html-listing.js";
import type { RouteDiscoveryEndpoint, SourceConfig } from "../../types.js";

type Endpoint = RouteDiscoveryEndpoint;

const articlePrefixes: Record<string, string[]> = {
  culture: ["/en/cultura/noticia/"],
  economy: ["/en/economia/noticia/"],
  education: ["/en/educacao/noticia/"],
  general: ["/en/geral/noticia/"],
  health: ["/en/saude/noticia/"],
  "human-rights": ["/en/direitos-humanos/noticia/"],
};

export function discoverAgenciaBrasil(source: SourceConfig, endpoint: Endpoint, fetchedAt: string) {
  const prefixes = articlePrefixes[endpoint.route];
  if (!prefixes) throw new Error(`${source.id}: unsupported route: ${endpoint.route}`);
  return discoverHtmlListing(source, fetchedAt, {
    listingUrl: sectionUrl(source, endpoint.route),
    articlePathPrefixes: prefixes,
    maximumItems: endpoint.maximumItems,
    bodySelectors: [".field--name-body", ".content_desc"],
    version: "agencia-brasil-html/1",
  });
}
