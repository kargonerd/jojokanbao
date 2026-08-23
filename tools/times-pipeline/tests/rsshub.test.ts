import { describe, expect, it } from "vitest";
import { mapRssHubData } from "../src/discovery/rsshub.js";
import type { SourceConfig } from "../src/types.js";

const source: SourceConfig = {
  id: "people",
  name: "人民网",
  language: "zh-CN",
  discovery: { kind: "rsshub-package", route: "/people" },
  content: { priority: ["discovery-body", "discovery-summary"], parser: "people" },
  archive: { mode: "browser", bpc: true },
  health: { minimumCandidates: 1 },
  enabled: true,
};

describe("RSSHub package mapping", () => {
  it("maps route Data without serializing it back to RSS", () => {
    const result = mapRssHubData(source, {
      title: "人民网",
      link: "https://people.com.cn/",
      item: [{
        title: "测试新闻",
        link: "https://people.com.cn/a/1?utm_source=test",
        pubDate: "2026-08-23T10:00:00Z",
        description: "<p>完整正文</p>",
        author: "记者甲",
        category: ["政治"],
      }],
    }, "2026-08-23T10:05:00Z");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      sourceId: "people",
      title: "测试新闻",
      canonicalUrl: "https://people.com.cn/a/1",
      contentStatus: "full",
      discoveryBody: "<p>完整正文</p>",
      authors: ["记者甲"],
      publisherCategories: ["政治"],
    });
  });

  it("rejects a route-level RSSHub error", () => {
    expect(() => mapRssHubData(source, { error: { message: "upstream returned 404" } }, "2026-08-23T10:05:00Z"))
      .toThrow("RSSHub route failed");
  });

  it("classifies mixed route entries article by article", () => {
    const thresholdSource: SourceConfig = {
      ...source,
      content: {
        ...source.content,
        minimumFullCharacters: 20,
        minimumFullParagraphs: 2,
      },
    };
    const result = mapRssHubData(thresholdSource, {
      link: "https://example.test/",
      item: [{
        title: "Full",
        link: "https://example.test/full",
        pubDate: "2026-08-23T10:00:00Z",
        description: "<p>This is a complete first paragraph.</p><p>This is the second paragraph.</p>",
      }, {
        title: "Teaser",
        link: "https://example.test/teaser",
        pubDate: "2026-08-23T09:00:00Z",
        description: "<p>Short teaser</p>",
      }],
    }, "2026-08-23T10:05:00Z");
    expect(result.candidates.map((candidate) => candidate.contentStatus)).toEqual(["full", "summary"]);
    expect(result.candidates[1]?.discoveryBody).toBeUndefined();
  });
});
