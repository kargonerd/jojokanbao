import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  candidateArticleIds,
  candidateUnchangedArticleIds,
  canonicalArticleAssets,
  candidateDates,
  candidateObject,
  candidateRawPages,
  canonicalObjects,
  canonicalTranslationObjects,
  HfTimesDataset,
  rawPageHtmlObjects,
  referencedCanonicalArticleObjects,
  rawStateObjects,
  rawRunMatchesGitHubRunId,
  retryTransientHf,
} from "../src/hf.js";

const { datasetInfoMock, downloadFileMock, uploadFilesMock } = vi.hoisted(() => ({
  datasetInfoMock: vi.fn(),
  downloadFileMock: vi.fn(),
  uploadFilesMock: vi.fn(),
}));

vi.mock("@huggingface/hub", async (importOriginal) => ({
  ...await importOriginal<typeof import("@huggingface/hub")>(),
  datasetInfo: datasetInfoMock,
  downloadFile: downloadFileMock,
  uploadFiles: uploadFilesMock,
}));

beforeEach(() => {
  datasetInfoMock.mockReset();
  downloadFileMock.mockReset();
  uploadFilesMock.mockReset();
});

describe("HF snapshot selection", () => {
  it("addresses source state objects directly without scanning Raw history", () => {
    expect(rawStateObjects(["reuters", "ap", "reuters"])).toEqual([
      "raw/ap/state.json.gz",
      "raw/reuters/state.json.gz",
    ]);
    expect(() => rawStateObjects(["../unsafe"])).toThrow("Invalid source id");
  });

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
      JSON.stringify({ publishedAt: "2026-08-23T23:30:00-04:00" }),
      JSON.stringify({ publishedAt: "not-a-date" }),
      "",
    ].join("\n"));
    const dates = candidateDates(compressed);
    expect(dates).toEqual(new Set(["2026-08-22", "2026-08-23", "2026-08-24"]));
    expect(canonicalObjects("ap", dates)).toEqual(new Set([
      "canonical/ap/dataset.json",
      "canonical/ap/dates/2026/08/2026-08-22.json.gz",
      "canonical/ap/dates/2026/08/2026-08-23.json.gz",
      "canonical/ap/dates/2026/08/2026-08-24.json.gz",
    ]));
  });

  it("selects Canonical articles and assets needed to retry unchanged translations", () => {
    const candidates = gzipSync([
      JSON.stringify({ articleId: "ap:retry", captureStatus: "unchanged" }),
      JSON.stringify({ articleId: "ap:captured", captureStatus: "captured" }),
      "",
    ].join("\n"));
    const unchanged = candidateUnchangedArticleIds(candidates);
    expect(unchanged).toEqual(new Set(["ap:retry"]));
    expect(candidateArticleIds(candidates)).toEqual(new Set(["ap:retry", "ap:captured"]));

    const articleObject = "canonical/ap/articles/retry.json.gz";
    const dateIndex = gzipSync(JSON.stringify({
      articles: [
        { articleId: "ap:retry", object: articleObject },
        { articleId: "ap:other", object: "canonical/ap/articles/other.json.gz" },
      ],
    }));
    expect(referencedCanonicalArticleObjects(dateIndex, "ap", unchanged)).toEqual(new Set([articleObject]));

    const article = gzipSync(JSON.stringify({
      assets: [
        { rawObject: "raw/ap/assets/one.jpg" },
        { rawObject: "raw/ap/assets/two.jpg" },
      ],
    }));
    expect(canonicalArticleAssets(article)).toEqual(new Set([
      "raw/ap/assets/one.jpg",
      "raw/ap/assets/two.jpg",
    ]));
  });

  it("restores only translation caches matching the current source dates", () => {
    const matching = "canonical/ap/translations/gemma-news-zh-v2/2026/08/2026-08-23/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json.gz";
    expect(canonicalTranslationObjects(new Set([
      matching,
      "canonical/ap/translations/gemma-news-zh-v2/2026/08/2026-08-22/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json.gz",
      "canonical/reuters/translations/gemma-news-zh-v2/2026/08/2026-08-23/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.json.gz",
      "canonical/ap/articles/article.json.gz",
    ]), new Map([["ap", new Set(["2026-08-23"])]]))).toEqual(new Set([matching]));
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

  it("selectively restores original HTML only for sources with an original-page hook", () => {
    const metadataObject = "raw/ft/runs/run/pages/one/metadata.json";
    const metadata = {
      renderedHtml: "rendered.html.gz",
      originalHtml: "original.html.gz",
    };
    expect(rawPageHtmlObjects(metadataObject, metadata, false)).toEqual([
      "raw/ft/runs/run/pages/one/rendered.html.gz",
    ]);
    expect(rawPageHtmlObjects(metadataObject, metadata, true)).toEqual([
      "raw/ft/runs/run/pages/one/rendered.html.gz",
      "raw/ft/runs/run/pages/one/original.html.gz",
    ]);
    expect(() => rawPageHtmlObjects(metadataObject, {
      ...metadata,
      originalHtml: { invalid: true },
    }, false)).not.toThrow();
    expect(() => rawPageHtmlObjects(metadataObject, {
      ...metadata,
      originalHtml: { invalid: true },
    }, true)).toThrow("originalHtml is invalid");
  });

  it("matches a Raw run to the exact GitHub Actions Capture run", () => {
    expect(rawRunMatchesGitHubRunId("20260828T151354001Z-33183877345", "33183877345")).toBe(true);
    expect(rawRunMatchesGitHubRunId("20260828T151354001Z-133183877345", "33183877345")).toBe(false);
    expect(rawRunMatchesGitHubRunId("20260828T151354001Z-33183877345", "not-a-run")).toBe(false);
  });

  it("retries transient HF responses and network failures", async () => {
    let calls = 0;
    const result = await retryTransientHf(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("gateway timeout"), { statusCode: 504 });
      if (calls === 2) throw new TypeError("fetch failed");
      return "downloaded";
    }, { attempts: 4, delayMs: 0, label: "test object" });

    expect(result).toBe("downloaded");
    expect(calls).toBe(3);
  });

  it("does not retry deterministic HF authorization failures", async () => {
    let calls = 0;
    await expect(retryTransientHf(async () => {
      calls += 1;
      throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    }, { attempts: 4, delayMs: 0 })).rejects.toThrow("forbidden");
    expect(calls).toBe(1);
  });

  it("retries transient HF preupload failures when committing files", async () => {
    vi.useFakeTimers();
    try {
      uploadFilesMock
        .mockRejectedValueOnce(Object.assign(new Error("preupload failed"), { statusCode: 502 }))
        .mockResolvedValueOnce({ commit: { oid: "raw-revision" } });
      const dataset = new HfTimesDataset("owner/dataset", ".", "token");
      const uploaded = dataset.uploadLocalFiles([
        { local: "package.json", objectName: "raw/ap/state.json.gz" },
      ], "Times Raw test-run");

      await vi.runAllTimersAsync();

      await expect(uploaded).resolves.toBe("raw-revision");
      expect(uploadFilesMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      uploadFilesMock.mockReset();
    }
  });
});
