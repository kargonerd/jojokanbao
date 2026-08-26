import { describe, expect, it } from "vitest";
import { parseSitemap } from "../src/discovery/sitemap.js";
import type { SourceConfig } from "../src/types.js";

const reuters: SourceConfig = {
  id: "reuters",
  name: "Reuters",
  language: "en",
  publicationTimeZone: "UTC",
  discovery: {
    kind: "sitemap",
    url: "https://www.reuters.com/arc/outboundfeeds/sitemap-index/?outputType=xml",
    maximumPages: 20,
  },
  content: { priority: ["captured-page", "discovery-summary"], parser: "reuters" },
  fetch: { strategy: "browser-first", bpc: true, proxyPolicy: "rotate" },
  health: { minimumCandidates: 1 },
  enabled: true,
};

describe("sitemap discovery", () => {
  it("maps URL and lastmod as a metadata-only candidate", () => {
    const result = parseSitemap(reuters, `<?xml version="1.0"?><urlset><url><loc>https://www.reuters.com/world/example-story-2026-08-23/</loc><lastmod>2026-08-23T06:00:00Z</lastmod></url></urlset>`, "2026-08-23T07:00:00Z");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      canonicalUrl: "https://www.reuters.com/world/example-story-2026-08-23",
      title: "Example story",
      contentStatus: "metadata",
      publishedAt: "2026-08-23T06:00:00.000Z",
    });
  });
});
