import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeSourceCapture } from "../src/raw-writer.js";
import type { Candidate, DiscoveryResult, SourceConfig } from "../src/types.js";

const source: SourceConfig = {
  id: "example",
  name: "Example",
  language: "en",
  sections: [
    { id: "world", name: "World", url: "https://example.com/world", kind: "region" },
    { id: "business", name: "Business", url: "https://example.com/business", kind: "topic" },
  ],
  discovery: {
    kind: "multi",
    targets: [
      { id: "world", sectionIds: ["world"], discovery: { kind: "official-rss", url: "https://example.com/world.xml" } },
      { id: "business", sectionIds: ["business"], discovery: { kind: "official-rss", url: "https://example.com/business.xml" } },
    ],
  },
  content: { priority: ["discovery-summary"], parser: "generic" },
  archive: { mode: "browser", bpc: false },
  health: { minimumCandidates: 1 },
  enabled: true,
};

const candidate: Candidate = {
  articleId: "example:one",
  sourceId: "example",
  sourceName: "Example",
  language: "en",
  sourceUrl: "https://example.com/world/one",
  canonicalUrl: "https://example.com/world/one",
  title: "One",
  contentStatus: "metadata",
  publishedAt: "2026-08-25T00:00:00Z",
  authors: [],
  publisherCategories: [],
  publisherSections: [{ id: "world", name: "World" }],
};

async function writeResult(targets: Array<Record<string, unknown>>) {
  const output = await mkdtemp(path.join(os.tmpdir(), "jojo-times-raw-writer-"));
  const runRoot = path.join(output, "raw", "news", "example", "run-1");
  const networkFile = path.join(runRoot, "network", "exchanges.jsonl.gz");
  await mkdir(path.dirname(networkFile), { recursive: true });
  await writeFile(networkFile, "");
  const result: DiscoveryResult = {
    source,
    transport: "multi",
    fetchedAt: "2026-08-25T00:00:00Z",
    upstream: { targets },
    candidates: [candidate],
  };
  return writeSourceCapture(runRoot, "run-1", "2026-08-25T00:00:00Z", result, networkFile, 0);
}

describe("raw writer section coverage", () => {
  it("does not degrade a section whose endpoint worked but had no article in the time window", async () => {
    const manifest = await writeResult([
      { id: "world", sectionIds: ["world"], status: "ok" },
      { id: "business", sectionIds: ["business"], status: "ok" },
    ]);
    expect(manifest.healthStatus).toBe("healthy");
    expect(manifest.sectionCoverage).toMatchObject({ covered: ["business", "world"], uncovered: [] });
  });

  it("degrades when a selected section has no successful endpoint or matching article", async () => {
    const manifest = await writeResult([
      { id: "world", sectionIds: ["world"], status: "ok" },
      { id: "business", sectionIds: ["business"], status: "error" },
    ]);
    expect(manifest.healthStatus).toBe("degraded");
    expect(manifest.sectionCoverage).toMatchObject({ uncovered: ["business"], failedTargets: ["business"] });
  });
});
