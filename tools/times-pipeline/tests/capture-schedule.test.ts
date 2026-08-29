import { describe, expect, it } from "vitest";
import { proxyTailSourceIds, untriedProxyArticles } from "../src/capture/schedule.js";

const articles = [
  { articleId: "bloomberg:cursor", sourceId: "bloomberg" },
  { articleId: "bloomberg:live", sourceId: "bloomberg" },
  { articleId: "reuters:1", sourceId: "reuters" },
  { articleId: "reuters:2", sourceId: "reuters" },
  { articleId: "reuters:3", sourceId: "reuters" },
  { articleId: "reuters:4", sourceId: "reuters" },
];

describe("exhaustive proxy tail", () => {
  it("limits exhaustive retries to sources with a small residual failure set", () => {
    expect([...proxyTailSourceIds(articles, 3)]).toEqual(["bloomberg"]);
    expect([...proxyTailSourceIds(articles, 0)]).toEqual([]);
  });

  it("returns only articles that have not tried the current proxy candidate", () => {
    const tailSources = new Set(["bloomberg"]);
    const attempts = new Map<string, Set<string>>([
      ["bloomberg:cursor", new Set(["node-a"])],
      ["bloomberg:live", new Set(["node-b"])],
    ]);

    expect(untriedProxyArticles(articles, tailSources, attempts, "node-a").map((article) => article.articleId))
      .toEqual(["bloomberg:live"]);
    expect(untriedProxyArticles(articles, tailSources, attempts, "node-c").map((article) => article.articleId))
      .toEqual(["bloomberg:cursor", "bloomberg:live"]);
  });
});
