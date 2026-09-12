import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverSource } from "../src/discovery/multi.js";
import { articleFingerprint, pendingArticles } from "../src/capture/pending.js";
import { axiosFetch } from "../src/sources/axios/fetch.js";
import type { SourceConfig } from "../src/types.js";

const source: SourceConfig = {
  id: "example",
  name: "Example",
  language: "en",
  publicationTimeZone: "UTC",
  sections: [
    { id: "world", name: "World", url: "https://example.test/world" },
    { id: "business", name: "Business", url: "https://example.test/business" },
  ],
  discovery: {
    kind: "multi",
    targets: [
      { id: "world", sectionIds: ["world"], discovery: { kind: "official-rss", url: "https://example.test/world.xml" } },
      { id: "business", sectionIds: ["business"], discovery: { kind: "official-rss", url: "https://example.test/business.xml" } },
    ],
  },
  content: { priority: ["discovery-summary"] },
  fetch: { strategy: "direct-first", bpc: true },
  health: { minimumCandidates: 1 },
  enabled: true,
};

afterEach(() => vi.unstubAllGlobals());

describe("multi-section discovery", () => {
  it("propagates a single RSS source's capture policy so revised extractors refresh cached pages", async () => {
    const url = "https://www.axios.com/2026/09/10/trump-dividend-check-5000";
    const fetchedAt = "2026-09-10T13:00:00Z";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<rss><channel><item>
      <title>News headline</title><link>${url}</link>
      <pubDate>Thu, 10 Sep 2026 10:00:00 GMT</pubDate><description>Summary</description>
    </item></channel></rss>`)));
    const result = await discoverSource({
      ...source, id: "axios", discovery: { kind: "official-rss", url: "https://api.axios.com/feed/" },
    }, fetchedAt, Date.parse("2026-09-09T13:00:00Z"));
    expect(result.fetchPolicy).toEqual(axiosFetch);
    const candidate = result.candidates[0]!;
    const previousPage = {
      articleId: candidate.articleId, sourceId: "axios", title: candidate.title,
      canonicalUrl: url, captureUrl: url, publishedAt: candidate.publishedAt, needsBody: true,
    };
    const state = new Map([["axios", {
      formatVersion: "jojo-page-capture-state/1" as const,
      articles: { [candidate.articleId]: {
        fingerprint: articleFingerprint(previousPage), lastAttempt: fetchedAt,
        rawPageObject: "raw/previous-page.json",
      } },
    }]]);
    const options = { now: new Date(fetchedAt), retentionDays: 8, refreshHours: 168, retryHours: 1 };
    expect(pendingArticles([previousPage], state, options)).toEqual([]);
    const revisedPage = { ...previousPage, captureRevision: result.fetchPolicy?.revision ?? "" };
    expect(pendingArticles([revisedPage], state, options)).toEqual([revisedPage]);
  });

  it("deduplicates parent/child feed entries and keeps every matched section", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<?xml version="1.0"?>
      <rss><channel><item>
        <title>Shared story</title>
        <link>https://example.test/articles/shared</link>
        <pubDate>Tue, 25 Aug 2026 05:00:00 GMT</pubDate>
        <description>Summary</description>
      </item><item>
        <title>Picture gallery</title>
        <link>https://example.test/world/gallery/pictures</link>
        <pubDate>Tue, 25 Aug 2026 05:05:00 GMT</pubDate>
        <description>Images rather than an article body</description>
      </item></channel></rss>`, { status: 200 })));

    const result = await discoverSource(source, "2026-08-25T05:10:00Z", Date.parse("2026-08-24T05:10:00Z"));

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.publisherSections).toEqual([
      { id: "world", name: "World" },
      { id: "business", name: "Business" },
    ]);
  });
});
