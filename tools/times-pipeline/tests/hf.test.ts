import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  parseHfFileSetManifest,
  referencedCanonicalArticleObjects,
  rawStateObjects,
  rawRunMatchesGitHubRunId,
  retryTransientHf,
  validateArchiveCanonicalFileSetScope,
  validateArchiveFileSetScope,
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

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function archiveCanonicalFixture(rawRevision = "a".repeat(40)): {
  report: Record<string, unknown>;
  reportObject: string;
  objects: { dataset: string; article: string; date: string };
} {
  const rawRunId = "archive-run-1";
  const objects = {
    dataset: "canonical/bloomberg/dataset.json",
    article: `canonical/bloomberg/articles/${"b".repeat(64)}.json.gz`,
    date: "canonical/bloomberg/dates/2020/01/2020-01-02.json.gz",
  };
  const reportObject = `canonical/archive-runs/${sha256(rawRunId).slice(0, 24)}.json`;
  return {
    reportObject,
    objects,
    report: {
      formatVersion: "jojo-news-archive-canonical-run/1",
      rawRunId,
      rawRunManifest: `raw/archive/runs/2026/08/30/${rawRunId}/manifest.json`,
      sourceRawRevision: "c".repeat(40),
      rawRevision,
      processedAt: "2026-08-30T12:00:00.000Z",
      sources: [{
        sourceId: "bloomberg",
        dates: ["2020-01-02"],
        articles: [{ object: objects.article }],
        files: [objects.dataset, objects.article, objects.date],
      }],
    },
  };
}

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

describe("HF exact file-set transport", () => {
  it("parses the versioned manifest, defaults required, and rejects unsafe or duplicate paths", () => {
    const digest = sha256("one");
    expect(parseHfFileSetManifest({
      formatVersion: "jojo-hf-file-set/1",
      files: [{ localPath: "raw/one.html", objectName: "raw/archive/one.html", size: 3, sha256: digest }],
    }).files[0]?.required).toBe(true);

    expect(() => parseHfFileSetManifest({
      formatVersion: "jojo-hf-file-set/1",
      files: [
        { localPath: "raw/one.html", objectName: "raw/archive/one.html", size: 3, sha256: digest },
        { localPath: "raw/two.html", objectName: "raw/archive/one.html", size: 3, sha256: digest },
      ],
    })).toThrow("Duplicate HF object name");
    expect(() => parseHfFileSetManifest({
      formatVersion: "jojo-hf-file-set/1",
      files: [{ localPath: "../outside", objectName: "raw/archive/one.html", size: 3, sha256: digest }],
    })).toThrow("Unsafe HF local path");
    expect(() => parseHfFileSetManifest({
      formatVersion: "jojo-hf-file-set/1",
      files: [{ localPath: "raw/one.html", objectName: "raw\\archive\\one.html", size: 3, sha256: digest }],
    })).toThrow("Invalid HF object path");
    expect(() => parseHfFileSetManifest({
      formatVersion: "jojo-hf-file-set/1",
      files: [],
      extra: true,
    })).toThrow("must contain only formatVersion and files");
    expect(() => parseHfFileSetManifest({
      formatVersion: "jojo-hf-file-set/1",
      files: [{
        localPath: "raw/one.html",
        objectName: "raw/archive/one.html",
        size: 3,
        sha256: digest,
        extra: true,
      }],
    })).toThrow("unsupported fields");
  });

  it("restricts generic exact uploads to one approved archive scope", () => {
    const manifest = parseHfFileSetManifest({
      formatVersion: "jojo-hf-file-set/1",
      files: [{
        localPath: "one.html",
        objectName: "raw/archive/v1/bloomberg/2020-2020/wayback/raw/objects/html/aa/one.html.gz",
        size: 3,
        sha256: sha256("one"),
      }],
    });
    expect(validateArchiveFileSetScope(
      manifest,
      "raw/archive/v1/bloomberg/2020-2020/wayback/",
      "immutable",
    )).toEqual(manifest);
    expect(() => validateArchiveFileSetScope(manifest, "raw/archive/", "immutable"))
      .toThrow("outside approved archive scopes");
    expect(() => validateArchiveFileSetScope(
      manifest,
      "raw/archive/v1/bloomberg/2020-2020/wayback/",
      "replace",
    )).toThrow("cannot use replace policy");
    expect(() => validateArchiveFileSetScope(
      manifest,
      "raw/archive/v1/wsj/2020-2020/wayback/",
      "immutable",
    )).toThrow("contains an object outside");
  });

  it("binds a historical Canonical manifest to one exact run report and mixed object policies", () => {
    const fixture = archiveCanonicalFixture();
    const manifest = parseHfFileSetManifest({
      formatVersion: "jojo-hf-file-set/1",
      files: [fixture.reportObject, ...Object.values(fixture.objects)].map((objectName) => ({
        localPath: objectName,
        objectName,
        size: 3,
        sha256: sha256("one"),
        required: true,
      })),
    });
    const plan = validateArchiveCanonicalFileSetScope(manifest, fixture.report);
    expect(plan.reportObject).toBe(fixture.reportObject);
    expect([...plan.immutableObjects].sort()).toEqual([fixture.objects.article, fixture.reportObject].sort());
    expect([...plan.replaceObjects].sort()).toEqual([fixture.objects.dataset, fixture.objects.date].sort());

    const extra = parseHfFileSetManifest({
      ...manifest,
      files: [...manifest.files, {
        localPath: "canonical/bloomberg/unscoped.json",
        objectName: "canonical/bloomberg/unscoped.json",
        size: 3,
        sha256: sha256("one"),
        required: true,
      }],
    });
    expect(() => validateArchiveCanonicalFileSetScope(extra, fixture.report))
      .toThrow("does not exactly match its report");
    expect(() => validateArchiveCanonicalFileSetScope(manifest, {
      ...fixture.report,
      rawRunManifest: "raw/archive/runs/2026/08/30/other-run/manifest.json",
    })).toThrow("does not match its Raw run manifest");
  });

  it("uploads historical Canonical mutable and fail-closed objects in one pinned commit", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "jojo-hf-archive-canonical-"));
    try {
      const parent = "a".repeat(40);
      const fixture = archiveCanonicalFixture(parent);
      const bodies = new Map<string, Buffer>([
        [fixture.objects.dataset, Buffer.from("dataset")],
        [fixture.objects.article, Buffer.from("article")],
        [fixture.objects.date, Buffer.from("date")],
        [fixture.reportObject, Buffer.from(`${JSON.stringify(fixture.report)}\n`)],
      ]);
      for (const [objectName, body] of bodies) {
        const file = path.join(output, ...objectName.split("/"));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, body);
      }
      const manifest = parseHfFileSetManifest({
        formatVersion: "jojo-hf-file-set/1",
        files: [...bodies].map(([objectName, body]) => ({
          localPath: objectName,
          objectName,
          size: body.byteLength,
          sha256: sha256(body),
          required: true,
        })),
      });
      datasetInfoMock.mockResolvedValue({ sha: parent });
      downloadFileMock.mockImplementation(({ path: objectName }: { path: string }) => (
        objectName === fixture.objects.article ? Promise.resolve(new Blob(["article"])) : Promise.resolve(null)
      ));
      uploadFilesMock.mockResolvedValue({ commit: { oid: "canonical-commit" } });
      const dataset = new HfTimesDataset("owner/dataset", output, "token");

      await expect(dataset.uploadArchiveCanonicalFileSet(manifest, "archive canonical", parent)).resolves.toEqual({
        revision: "canonical-commit",
        uploaded: 3,
        skipped: [fixture.objects.article],
      });
      expect(uploadFilesMock).toHaveBeenCalledTimes(1);
      expect(uploadFilesMock).toHaveBeenCalledWith(expect.objectContaining({
        parentCommit: parent,
        files: expect.arrayContaining([
          expect.objectContaining({ path: fixture.objects.dataset }),
          expect.objectContaining({ path: fixture.objects.date }),
          expect.objectContaining({ path: fixture.reportObject }),
        ]),
      }));
      expect((uploadFilesMock.mock.calls[0]![0] as { files: Array<{ path: string }> }).files)
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ path: fixture.objects.article })]));

      uploadFilesMock.mockReset();
      downloadFileMock.mockImplementation(({ path: objectName }: { path: string }) => (
        objectName === fixture.objects.article ? Promise.resolve(new Blob(["different"])) : Promise.resolve(null)
      ));
      await expect(dataset.uploadArchiveCanonicalFileSet(manifest, "archive canonical", parent))
        .rejects.toThrow(`Immutable HF object already exists with different bytes: ${fixture.objects.article}`);
      expect(uploadFilesMock).not.toHaveBeenCalled();
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it("verifies size and SHA-256 before uploading and skips optional missing files", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "jojo-hf-upload-"));
    try {
      await mkdir(path.join(output, "raw"), { recursive: true });
      await writeFile(path.join(output, "raw", "one.html"), "one");
      datasetInfoMock.mockResolvedValue({ sha: "head-one" });
      uploadFilesMock.mockResolvedValue({ commit: { oid: "commit-one" } });
      const dataset = new HfTimesDataset("owner/dataset", output, "token");
      const result = await dataset.uploadFileSet(parseHfFileSetManifest({
        formatVersion: "jojo-hf-file-set/1",
        files: [
          {
            localPath: "raw/one.html",
            objectName: "raw/archive/one.html",
            size: 3,
            sha256: sha256("one"),
          },
          {
            localPath: "raw/optional.html",
            objectName: "raw/archive/optional.html",
            size: 8,
            sha256: sha256("optional"),
            required: false,
          },
        ],
      }), "archive upload");

      expect(result).toEqual({
        revision: "commit-one",
        uploaded: 1,
        skipped: ["raw/archive/optional.html"],
      });
      expect(uploadFilesMock).toHaveBeenCalledTimes(1);
      expect(uploadFilesMock).toHaveBeenCalledWith(expect.objectContaining({
        parentCommit: "head-one",
        commitTitle: "archive upload",
        files: [expect.objectContaining({ path: "raw/archive/one.html" })],
      }));
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it("fails before upload when a required local file is missing or has the wrong digest", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "jojo-hf-upload-invalid-"));
    try {
      await writeFile(path.join(output, "present.txt"), "present");
      const dataset = new HfTimesDataset("owner/dataset", output, "token");
      await expect(dataset.uploadFileSet(parseHfFileSetManifest({
        formatVersion: "jojo-hf-file-set/1",
        files: [{
          localPath: "missing.txt",
          objectName: "raw/archive/missing.txt",
          size: 7,
          sha256: sha256("missing"),
        }],
      }), "missing upload")).rejects.toThrow("Required HF upload file is missing");
      await expect(dataset.uploadFileSet(parseHfFileSetManifest({
        formatVersion: "jojo-hf-file-set/1",
        files: [{
          localPath: "present.txt",
          objectName: "raw/archive/present.txt",
          size: 7,
          sha256: sha256("changed"),
        }],
      }), "bad digest upload")).rejects.toThrow("HF upload SHA-256 mismatch");
      expect(datasetInfoMock).not.toHaveBeenCalled();
      expect(uploadFilesMock).not.toHaveBeenCalled();
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it("fails conflicts by default and retries 409 only with retry-disjoint", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "jojo-hf-conflict-"));
    try {
      await writeFile(path.join(output, "one.txt"), "one");
      const manifest = parseHfFileSetManifest({
        formatVersion: "jojo-hf-file-set/1",
        files: [{
          localPath: "one.txt",
          objectName: "raw/archive/one.txt",
          size: 3,
          sha256: sha256("one"),
        }],
      });
      datasetInfoMock.mockResolvedValue({ sha: "head-one" });
      uploadFilesMock.mockRejectedValue(Object.assign(new Error("conflict"), { statusCode: 409 }));
      const dataset = new HfTimesDataset("owner/dataset", output, "token");
      await expect(dataset.uploadFileSet(manifest, "default conflict")).rejects.toThrow("conflict");
      expect(datasetInfoMock).toHaveBeenCalledTimes(1);
      expect(uploadFilesMock).toHaveBeenCalledTimes(1);

      datasetInfoMock.mockReset()
        .mockResolvedValueOnce({ sha: "head-one" })
        .mockResolvedValueOnce({ sha: "head-two" });
      uploadFilesMock.mockReset()
        .mockRejectedValueOnce(Object.assign(new Error("conflict"), { statusCode: 409 }))
        .mockResolvedValueOnce({ commit: { oid: "commit-two" } });
      await expect(dataset.uploadFileSet(manifest, "disjoint conflict", "retry-disjoint")).resolves.toEqual({
        revision: "commit-two",
        uploaded: 1,
        skipped: [],
      });
      expect(datasetInfoMock).toHaveBeenCalledTimes(2);
      expect(uploadFilesMock.mock.calls.map(([options]) => options.parentCommit)).toEqual(["head-one", "head-two"]);

      datasetInfoMock.mockReset().mockResolvedValue({ sha: "head-three" });
      uploadFilesMock.mockReset().mockRejectedValue(Object.assign(new Error("precondition"), { statusCode: 412 }));
      await expect(dataset.uploadFileSet(manifest, "non-409", "retry-disjoint")).rejects.toThrow("precondition");
      expect(datasetInfoMock).toHaveBeenCalledTimes(1);
      expect(uploadFilesMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it("pins an expected upload parent and never refreshes it after a conflict", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "jojo-hf-pinned-parent-"));
    try {
      await writeFile(path.join(output, "one.txt"), "one");
      const manifest = parseHfFileSetManifest({
        formatVersion: "jojo-hf-file-set/1",
        files: [{
          localPath: "one.txt",
          objectName: "canonical/archive/one.txt",
          size: 3,
          sha256: sha256("one"),
        }],
      });
      const expected = "a".repeat(40);
      const changed = "b".repeat(40);
      const dataset = new HfTimesDataset("owner/dataset", output, "token");

      datasetInfoMock.mockResolvedValue({ sha: changed });
      await expect(dataset.uploadFileSet(manifest, "pinned", "fail", expected))
        .rejects.toThrow(`expected parent ${expected}, found ${changed}`);
      expect(uploadFilesMock).not.toHaveBeenCalled();

      datasetInfoMock.mockReset().mockResolvedValue({ sha: expected });
      uploadFilesMock.mockRejectedValue(Object.assign(new Error("conflict"), { statusCode: 409 }));
      await expect(dataset.uploadFileSet(manifest, "pinned", "retry-disjoint", expected))
        .rejects.toThrow("conflict");
      expect(datasetInfoMock).toHaveBeenCalledTimes(1);
      expect(uploadFilesMock).toHaveBeenCalledTimes(1);
      expect(uploadFilesMock).toHaveBeenCalledWith(expect.objectContaining({ parentCommit: expected }));
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it("treats immutable HF objects as create-only and skips identical bytes", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "jojo-hf-immutable-"));
    try {
      await writeFile(path.join(output, "one.txt"), "one");
      const manifest = parseHfFileSetManifest({
        formatVersion: "jojo-hf-file-set/1",
        files: [{
          localPath: "one.txt",
          objectName: "raw/archive/v1/bloomberg/2020-2020/wayback/raw/objects/one.txt",
          size: 3,
          sha256: sha256("one"),
        }],
      });
      const parent = "a".repeat(40);
      datasetInfoMock.mockResolvedValue({ sha: parent });
      const dataset = new HfTimesDataset("owner/dataset", output, "token");

      downloadFileMock.mockResolvedValue(new Blob(["one"]));
      await expect(dataset.uploadFileSet(manifest, "same", "fail", parent, "immutable"))
        .resolves.toEqual({ revision: parent, uploaded: 0, skipped: [manifest.files[0]!.objectName] });
      expect(uploadFilesMock).not.toHaveBeenCalled();

      downloadFileMock.mockResolvedValue(new Blob(["different"]));
      await expect(dataset.uploadFileSet(manifest, "changed", "fail", parent, "immutable"))
        .rejects.toThrow("already exists with different bytes");
      expect(uploadFilesMock).not.toHaveBeenCalled();

      downloadFileMock.mockResolvedValue(null);
      uploadFilesMock.mockResolvedValue({ commit: { oid: "created" } });
      await expect(dataset.uploadFileSet(manifest, "new", "fail", parent, "immutable"))
        .resolves.toEqual({ revision: "created", uploaded: 1, skipped: [] });
      expect(uploadFilesMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it("downloads one fixed revision through verified temporary files and skips optional objects", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "jojo-hf-download-"));
    try {
      await mkdir(path.join(output, "raw"), { recursive: true });
      await writeFile(path.join(output, "raw", "one.html"), "old");
      datasetInfoMock.mockResolvedValue({ sha: "locked-revision" });
      downloadFileMock.mockImplementation(({ path: objectName }: { path: string }) => (
        objectName === "raw/archive/one.html" ? Promise.resolve(new Blob(["new article"])) : Promise.resolve(null)
      ));
      const dataset = new HfTimesDataset("owner/dataset", output, "token");
      const result = await dataset.downloadFileSet(parseHfFileSetManifest({
        formatVersion: "jojo-hf-file-set/1",
        files: [
          {
            localPath: "raw/one.html",
            objectName: "raw/archive/one.html",
            size: 11,
            sha256: sha256("new article"),
          },
          {
            localPath: "raw/optional.html",
            objectName: "raw/archive/optional.html",
            size: 8,
            sha256: sha256("optional"),
            required: false,
          },
        ],
      }), "migration-tag");

      expect(result).toEqual({
        revision: "locked-revision",
        downloaded: 1,
        skipped: ["raw/archive/optional.html"],
      });
      expect(datasetInfoMock).toHaveBeenCalledTimes(1);
      expect(datasetInfoMock).toHaveBeenCalledWith(expect.objectContaining({ revision: "migration-tag" }));
      expect(downloadFileMock).toHaveBeenCalledTimes(2);
      expect(downloadFileMock.mock.calls.every(([options]) => options.revision === "locked-revision")).toBe(true);
      expect(await readFile(path.join(output, "raw", "one.html"), "utf8")).toBe("new article");
      expect((await readdir(path.join(output, "raw"))).some((name) => name.endsWith(".tmp"))).toBe(false);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it("does not replace targets when a required download is missing or invalid", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "jojo-hf-download-invalid-"));
    try {
      await writeFile(path.join(output, "one.txt"), "old");
      datasetInfoMock.mockResolvedValue({ sha: "locked-revision" });
      downloadFileMock.mockImplementation(({ path: objectName }: { path: string }) => (
        objectName === "raw/archive/one.txt" ? Promise.resolve(new Blob(["new"])) : Promise.resolve(null)
      ));
      const dataset = new HfTimesDataset("owner/dataset", output, "token");
      await expect(dataset.downloadFileSet(parseHfFileSetManifest({
        formatVersion: "jojo-hf-file-set/1",
        files: [
          {
            localPath: "one.txt",
            objectName: "raw/archive/one.txt",
            size: 3,
            sha256: sha256("new"),
          },
          {
            localPath: "missing.txt",
            objectName: "raw/archive/missing.txt",
            size: 7,
            sha256: sha256("missing"),
          },
        ],
      }))).rejects.toThrow("Required HF object is missing");
      expect(await readFile(path.join(output, "one.txt"), "utf8")).toBe("old");
      expect((await readdir(output)).some((name) => name.endsWith(".tmp"))).toBe(false);

      downloadFileMock.mockReset().mockResolvedValue(new Blob(["tampered"]));
      await expect(dataset.downloadFileSet(parseHfFileSetManifest({
        formatVersion: "jojo-hf-file-set/1",
        files: [{
          localPath: "one.txt",
          objectName: "raw/archive/one.txt",
          size: 8,
          sha256: sha256("expected"),
        }],
      }))).rejects.toThrow("HF download SHA-256 mismatch");
      expect(await readFile(path.join(output, "one.txt"), "utf8")).toBe("old");
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });
});
