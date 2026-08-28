import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadSources } from "../src/config.js";

describe("sources v2", () => {
  it("loads the complete Times source catalog", async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const catalog = JSON.parse(await readFile(path.join(root, "sources.v2.json"), "utf8")) as { sourceFiles: string[] };
    expect(catalog.sourceFiles).toHaveLength(22);
    expect(catalog.sourceFiles.every((file) => /^src\/sources\/[a-z0-9-]+\/source\.json$/u.test(file))).toBe(true);
    for (const sourceFile of catalog.sourceFiles) {
      const configured = JSON.parse(await readFile(path.join(root, sourceFile), "utf8")) as { id: string };
      expect(configured.id, `${sourceFile} must use its publisher directory as the source id`)
        .toBe(path.basename(path.dirname(sourceFile)));
    }
    const sources = await loadSources(path.join(root, "sources.v2.json"));
    expect(sources).toHaveLength(22);
    expect(Object.fromEntries(sources.map((source) => [source.id, source.publicationTimeZone]))).toEqual({
      "africanews": "Africa/Lagos",
      "agencia-brasil": "America/Sao_Paulo",
      "aljazeera": "Asia/Qatar",
      "ap": "UTC",
      "axios": "America/New_York",
      "bloomberg": "America/New_York",
      "chinanews": "Asia/Shanghai",
      "cls": "Asia/Shanghai",
      "cna": "Asia/Singapore",
      "dw": "Europe/Berlin",
      "focus-taiwan": "Asia/Taipei",
      "ft": "Europe/London",
      "guardian": "Europe/London",
      "nikkei": "Asia/Tokyo",
      "npr": "America/New_York",
      "nyt": "America/New_York",
      "people": "Asia/Shanghai",
      "reuters": "UTC",
      "scmp": "Asia/Hong_Kong",
      "thepaper": "Asia/Shanghai",
      "xinhua": "Asia/Shanghai",
      "zaobao": "Asia/Singapore",
    });
    expect(sources.map((source) => source.id).toSorted()).toEqual([
      "africanews",
      "agencia-brasil",
      "aljazeera",
      "ap",
      "axios",
      "bloomberg",
      "chinanews",
      "cls",
      "cna",
      "dw",
      "focus-taiwan",
      "ft",
      "guardian",
      "nikkei",
      "npr",
      "nyt",
      "people",
      "reuters",
      "scmp",
      "thepaper",
      "xinhua",
      "zaobao",
    ]);
    expect(sources.map((source) => source.id)).not.toContain("cctv");
    expect(sources.map((source) => source.id)).toContain("agencia-brasil");
    expect(sources.every((source) => Boolean(source.sections?.length))).toBe(true);
    expect(sources.reduce((count, source) => count + (source.sections?.length ?? 0), 0)).toBe(153);
    expect(sources.reduce((count, source) => count
      + (source.sections?.filter((section) => section.discoverable !== false).length ?? 0), 0)).toBe(146);
    expect(sources.find((source) => source.id === "reuters")?.discovery.kind).toBe("multi");
    expect(sources.find((source) => source.id === "guardian")?.discovery.kind).toBe("multi");
    expect(sources.find((source) => source.id === "scmp")?.fetch).toMatchObject({ strategy: "browser-first", bpc: true });
    expect(sources.find((source) => source.id === "nyt")?.fetch.browser).toBe("brave");
    expect(sources.find((source) => source.id === "nyt")?.fetch.retryWithoutBpcOnBlocked).toBe(true);
    expect(sources.find((source) => source.id === "cna")?.discovery.kind).toBe("multi");
    const ap = sources.find((source) => source.id === "ap");
    expect(ap?.discovery.kind).toBe("multi");
    expect(ap?.content).toMatchObject({ minimumFullCharacters: 400, minimumFullParagraphs: 3 });
    if (ap?.discovery.kind === "multi") {
      expect(ap.discovery.targets).toHaveLength(4);
      expect(ap.discovery.targets.every((target) =>
        target.discovery.kind === "source-adapter"
        && target.discovery.adapter === "ap"
        && target.discovery.driver === "http"
      )).toBe(true);
    }
    const bloombergSections = sources.find((source) => source.id === "bloomberg")?.sections;
    expect(bloombergSections)
      .toContainEqual(expect.objectContaining({ id: "asia", url: "https://www.bloomberg.com/asia", discoverable: false }));
    expect(bloombergSections)
      .toContainEqual(expect.objectContaining({ id: "ai", url: "https://www.bloomberg.com/ai", discoverable: false }));
    expect(sources.find((source) => source.id === "axios")?.sections?.every((section) => section.discoverable === false))
      .toBe(true);
    const configuredSections = sources.flatMap((source) => source.discovery.kind === "multi"
      ? source.discovery.targets.flatMap((target) => target.sectionIds.map((sectionId) => `${source.id}:${sectionId}`))
      : []);
    for (const source of sources) {
      for (const section of source.sections ?? []) {
        if (section.discoverable === false) continue;
        const hasInferenceRule = Boolean(section.match?.urlPrefixes?.length || section.match?.publisherCategories?.length);
        expect(
          configuredSections.includes(`${source.id}:${section.id}`) || hasInferenceRule,
          `${source.id}:${section.id} has neither a discovery target nor an inference rule`,
        ).toBe(true);
      }
    }
  });
});
