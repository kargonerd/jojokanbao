import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { candidateDates, candidateObject, candidateRawPages, canonicalObjects, rawRunMatchesGitHubRunId } from "../src/hf.js";

describe("HF snapshot selection", () => {
  it("resolves candidates beside the source manifest", () => {
    expect(candidateObject("raw/ap/runs/2026/08/23/run/manifest.json", {
      objects: [{ path: "candidates.jsonl.gz" }],
    })).toBe("raw/ap/runs/2026/08/23/run/candidates.jsonl.gz");
  });

  it("rejects parent traversal", () => {
    expect(() => candidateObject("raw/ap/runs/2026/08/23/run/manifest.json", {
      objects: [{ path: "../candidates.jsonl.gz" }],
    })).toThrow("Unsafe Raw object path");
  });

  it("selects only canonical shards matching candidate dates", () => {
    const compressed = gzipSync([
      JSON.stringify({ publishedAt: "2026-08-22T23:59:00Z" }),
      JSON.stringify({ publishedAt: "2026-08-23T08:00:00Z" }),
      JSON.stringify({ publishedAt: "not-a-date" }),
      "",
    ].join("\n"));
    const dates = candidateDates(compressed);
    expect(dates).toEqual(new Set(["2026-08-22", "2026-08-23"]));
    expect(canonicalObjects("ap", dates)).toEqual(new Set([
      "canonical/ap/dataset.json",
      "canonical/ap/dates/2026/08/2026-08-22.json.gz",
      "canonical/ap/dates/2026/08/2026-08-23.json.gz",
    ]));
  });

  it("selects Raw page metadata needed by Process", () => {
    const compressed = gzipSync([
      JSON.stringify({ rawPageObject: "raw/ap/runs/run/pages/one/metadata.json" }),
      JSON.stringify({ rawPageObject: "raw/ap/runs/run/pages/one/metadata.json" }),
      JSON.stringify({ title: "No captured page" }),
      "",
    ].join("\n"));
    expect(candidateRawPages(compressed)).toEqual(new Set([
      "raw/ap/runs/run/pages/one/metadata.json",
    ]));
  });

  it("matches a Raw run to the exact GitHub Actions Capture run", () => {
    expect(rawRunMatchesGitHubRunId("20260828T151354001Z-33183877345", "33183877345")).toBe(true);
    expect(rawRunMatchesGitHubRunId("20260828T151354001Z-133183877345", "33183877345")).toBe(false);
    expect(rawRunMatchesGitHubRunId("20260828T151354001Z-33183877345", "not-a-run")).toBe(false);
  });
});
