import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverSource } from "../src/discovery/multi.js";
import type { SourceConfig } from "../src/types.js";

const source: SourceConfig = {
  id: "example",
  name: "Example",
  language: "en",
  sections: [
    { id: "world", name: "World", url: "https://example.test/world", kind: "region" },
    { id: "business", name: "Business", url: "https://example.test/business", kind: "topic" },
  ],
  discovery: {
    kind: "multi",
    targets: [
      { id: "world", sectionIds: ["world"], discovery: { kind: "official-rss", url: "https://example.test/world.xml" } },
      { id: "business", sectionIds: ["business"], discovery: { kind: "official-rss", url: "https://example.test/business.xml" } },
    ],
  },
  content: { priority: ["discovery-summary"] },
  archive: { mode: "browser", bpc: true },
  health: { minimumCandidates: 1 },
  enabled: true,
};

afterEach(() => vi.unstubAllGlobals());

describe("multi-section discovery", () => {
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
