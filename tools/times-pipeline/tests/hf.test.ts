import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { candidateDates, candidateObject, canonicalObjects } from "../src/hf.js";

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
});
