import { describe, expect, it } from "vitest";
import { isCandidateAllowed } from "../src/candidate-policy.js";
import type { Candidate, SourceConfig } from "../src/types.js";

const source: SourceConfig = {
  id: "example",
  name: "Example",
  language: "en",
  discovery: { kind: "official-rss", url: "https://news.example.test/feed" },
  content: {
    priority: ["browser-parser", "discovery-summary"],
    allowedHostnames: ["news.example.test"],
    excludedPathPrefixes: ["/video/", "/photo/"],
  },
  archive: { mode: "browser", bpc: true },
  health: { minimumCandidates: 1 },
  enabled: true,
};

function candidate(url: string): Candidate {
  return {
    articleId: "example:one",
    sourceId: source.id,
    sourceName: source.name,
    language: source.language,
    sourceUrl: url,
    canonicalUrl: url,
    title: "Example",
    contentStatus: "summary",
    publishedAt: "2026-08-23T10:00:00Z",
    authors: [],
    publisherCategories: [],
  };
}

describe("candidate URL policy", () => {
  it("keeps publisher articles and excludes video, photo, and third-party URLs", () => {
    expect(isCandidateAllowed(source, candidate("https://news.example.test/world/story"))).toBe(true);
    expect(isCandidateAllowed(source, candidate("https://news.example.test/video/story"))).toBe(false);
    expect(isCandidateAllowed(source, candidate("https://news.example.test/gn/shipin/story.shtml"))).toBe(false);
    expect(isCandidateAllowed({
      ...source,
      content: { priority: source.content.priority, allowedHostnames: ["news.example.test"] },
    }, candidate("https://news.example.test/world/videos/story"))).toBe(false);
    expect(isCandidateAllowed(source, candidate("https://news.example.test/photo/story"))).toBe(false);
    expect(isCandidateAllowed(source, candidate("https://other.example.test/world/story"))).toBe(false);
  });

  it("excludes source-specific non-article collection pages", () => {
    const thepaper = {
      ...source,
      content: {
        ...source.content,
        allowedHostnames: ["m.thepaper.cn"],
        excludedPathPrefixes: ["/morningEveningPaper", "/papernews/morningEveningPaper"],
      },
    };

    expect(isCandidateAllowed(thepaper, candidate("https://m.thepaper.cn/newsDetail_forward_33836598"))).toBe(true);
    expect(isCandidateAllowed(thepaper, candidate("https://m.thepaper.cn/morningEveningPaper?n=168047"))).toBe(false);
    expect(isCandidateAllowed(thepaper, candidate("https://m.thepaper.cn/papernews/morningEveningPaper?n=168047"))).toBe(false);
  });
});
