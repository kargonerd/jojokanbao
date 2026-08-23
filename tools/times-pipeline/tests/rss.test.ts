import { describe, expect, it } from "vitest";
import { parseOfficialFeed } from "../src/discovery/rss.js";
import type { SourceConfig } from "../src/types.js";

const guardian: SourceConfig = {
  id: "guardian",
  name: "The Guardian",
  language: "en",
  discovery: { kind: "official-rss", url: "https://www.theguardian.com/world/rss" },
  content: { priority: ["browser-parser", "discovery-summary"], parser: "guardian" },
  archive: { mode: "browser", bpc: true },
  health: { minimumCandidates: 1 },
  enabled: true,
};

describe("official RSS discovery", () => {
  it("keeps Guardian feed text as a summary", () => {
    const result = parseOfficialFeed(guardian, `<?xml version="1.0"?>
      <rss version="2.0"><channel><item>
        <title>World headline</title>
        <link>https://www.theguardian.com/world/2026/aug/23/example</link>
        <pubDate>Sun, 23 Aug 2026 10:00:00 GMT</pubDate>
        <description><![CDATA[<p>Feed summary</p>]]></description>
        <dc:creator>Reporter</dc:creator>
      </item></channel></rss>`, "2026-08-23T10:05:00Z");
    expect(result.candidates[0]).toMatchObject({
      sourceId: "guardian",
      summary: "Feed summary",
      contentStatus: "summary",
      authors: ["Reporter"],
    });
    expect(result.candidates[0]?.discoveryBody).toBeUndefined();
  });
});
