import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSources } from "../src/config.js";

describe("sources v2", () => {
  it("loads the complete Times source catalog", async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const sources = await loadSources(path.join(root, "sources.v2.json"));
    expect(sources).toHaveLength(23);
    expect(sources.map((source) => source.id)).toContain("agencia-brasil");
    expect(sources.find((source) => source.id === "reuters")?.discovery.kind).toBe("sitemap");
    expect(sources.find((source) => source.id === "guardian")?.discovery.kind).toBe("official-rss");
    expect(sources.find((source) => source.id === "axios")?.content).toMatchObject({
      priority: ["discovery-body", "browser-parser", "discovery-summary"],
      minimumFullCharacters: 1000,
      minimumFullParagraphs: 5,
    });
    expect(sources.find((source) => source.id === "scmp")?.archive.bpc).toBe(true);
    expect(sources.find((source) => source.id === "cna-singapore")?.discovery.kind).toBe("official-rss-list");
    expect(sources.find((source) => source.id === "aljazeera-english")?.content.excludedPathPrefixes).toEqual(["/video/"]);
    expect(sources.find((source) => source.id === "ap")?.content).toMatchObject({
      allowedHostnames: ["apnews.com"],
      excludedPathPrefixes: ["/video/"],
    });
    expect(sources.find((source) => source.id === "cctv")?.content.allowedHostnames).toEqual(["news.cctv.com"]);
    expect(sources.find((source) => source.id === "chinanews")?.content.excludedPathPrefixes).toEqual([
      "/gn/shipin/",
      "/sh/shipin/",
    ]);
    expect(sources.find((source) => source.id === "thepaper")?.content.excludedPathPrefixes).toEqual([
      "/morningEveningPaper",
      "/papernews/morningEveningPaper",
    ]);
    expect(sources.find((source) => source.id === "focus-taiwan")?.content).toMatchObject({
      minimumFullCharacters: 500,
      minimumFullParagraphs: 3,
    });
  });
});
