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
    expect(sources.find((source) => source.id === "scmp")?.archive.bpc).toBe(true);
    expect(sources.find((source) => source.id === "cna-singapore")?.discovery.kind).toBe("official-rss-list");
  });
});
