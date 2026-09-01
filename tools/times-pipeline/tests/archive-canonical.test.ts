import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runArchiveCanonical } from "../src/archive-canonical-cli.js";
import {
  affectedCanonicalDateObjects,
  archiveAssetObjects,
  archiveSourceConfig,
  deduplicatePreparedRows,
  parseArchiveCanonicalInput,
  prepareArchiveRow,
  writeArchiveCanonical,
  type ArchiveCanonicalInput,
} from "../src/archive/canonical.js";

function archiveInput(overrides: Partial<ArchiveCanonicalInput> = {}): ArchiveCanonicalInput {
  return {
    formatVersion: "jojo-news-canonical-input/1",
    sourceId: "wsj",
    publisher: "wsj",
    canonicalUrl: "https://www.wsj.com/articles/example?utm_source=test",
    recordObject: "raw/archive/v1/wsj/2020-2020/wayback/raw/records/aa/example.json",
    rawHtmlObject: "raw/archive/v1/wsj/2020-2020/wayback/raw/objects/html/aa/example.html.gz",
    rawRevision: "a".repeat(40),
    rawRunId: "archive-run-1",
    rawRunManifest: "raw/archive/runs/2026/08/30/archive-run-1/manifest.json",
    captureRecord: {
      publisher: "wsj",
      canonicalUrl: "https://www.wsj.com/articles/example?utm_source=test",
      retrievedAt: "2026-08-30T08:00:00Z",
      finalUrl: "https://www.wsj.com/articles/example?utm_source=test",
      qualityScore: 100,
      selectedCandidate: { provider: "wayback" },
      rawHtml: {
        path: "objects/html/aa/example.html.gz",
        sha256: "b".repeat(64),
        byteCount: 1_000,
        storedByteCount: 500,
        contentEncoding: "gzip",
      },
      dependentResources: [],
    },
    parserResult: {
      canonicalUrl: "https://www.wsj.com/articles/example?utm_source=test",
      language: "en-US",
      section: "World",
      headline: "An archive report",
      authors: [{ name: "Reporter One" }, { name: "Reporter One" }],
      publishedAt: "2020-01-02T12:00:00Z",
      blocks: [
        {
          type: "paragraph",
          position: 0,
          text: "Opening paragraph with emphasis and an unsafe link.",
          html: '<p class="chrome">Opening <strong data-test="x">paragraph</strong><script>bad()</script> with <a href="javascript:bad()">an unsafe link</a>.</p>',
          items: [],
        },
        { type: "image", position: 1, assetId: "parser:image", items: [] },
        { type: "table", position: 2, text: "Country Value China 10", html: "<table><tr><th>Country</th><th>Value</th></tr><tr><td>China</td><td>10</td></tr></table>", items: [] },
      ],
      images: [
        {
          assetId: "parser:image",
          role: "body",
          originalUrl: "https://images.wsj.net/original.jpg",
          candidateUrls: ["https://images.wsj.net/best.jpg"],
          caption: "A single caption.",
          credit: "Archive Photographer",
          alt: "Editorial image",
          width: 1200,
          height: 800,
          shouldArchive: true,
        },
        {
          assetId: "parser:ad",
          role: "advertisement",
          originalUrl: "https://ads.example.test/banner.jpg",
          candidateUrls: [],
          shouldArchive: false,
        },
      ],
      extraction: { parserVersion: "wsj-parser/0.1.99" },
      quality: { status: "complete", bodyCharacters: 1_000, imagesSelected: 1 },
    },
    validation: {
      sampleYear: 2020,
      parserVersion: "wsj-parser/0.1.99",
      qaRevision: "qa-1",
      qaPass: true,
      issues: [],
      sourceRawSha256: "b".repeat(64),
    },
    ...overrides,
  };
}

async function writeRawRunManifest(
  workspace: string,
  value: ArchiveCanonicalInput = archiveInput(),
  options: { emptyCompletion?: boolean; wrongCompletion?: boolean } = {},
): Promise<void> {
  const file = path.join(workspace, ...value.rawRunManifest.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  const phaseOrder = ["immutable", "catalog", "checkpoint", "completion"] as const;
  const phases = [];
  const immutableFiles = [value.recordObject, value.rawHtmlObject].map((objectName, index) => ({
    localPath: objectName,
    objectName,
    size: index + 1,
    sha256: String(index + 1).repeat(64),
    required: true,
  }));
  const completionFiles = options.emptyCompletion ? [] : [{
    localPath: "state/summary.json",
    objectName: options.wrongCompletion
      ? "raw/archive/v1/wsj/2020-2020/wayback/raw/objects/html/ff/wrong.html.gz"
      : "raw/archive/v1/wsj/2020-2020/wayback/state/summary.json",
    size: 1,
    sha256: "3".repeat(64),
    required: true,
  }];
  let totalFiles = 0;
  let totalBytes = 0;
  for (const [index, phase] of phaseOrder.entries()) {
    const fileSetObject = `${value.rawRunManifest.slice(0, -"/manifest.json".length)}/file-sets/0${index + 1}-${phase}.json`;
    const files = phase === "immutable"
      ? immutableFiles
      : phase === "completion" ? completionFiles : [];
    const fileSet = Buffer.from(JSON.stringify({ formatVersion: "jojo-hf-file-set/1", files }));
    const target = path.join(workspace, ...fileSetObject.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, fileSet);
    const byteCount = files.reduce((total, item) => total + item.size, 0);
    totalFiles += files.length;
    totalBytes += byteCount;
    phases.push({
      phase,
      revision: phase === "completion" ? "9".repeat(40) : String(index + 1).repeat(40),
      fileSet: fileSetObject,
      fileSetSha256: createHash("sha256").update(fileSet).digest("hex"),
      files: files.length,
      bytes: byteCount,
    });
  }
  await writeFile(file, JSON.stringify({
    formatVersion: "jojo-news-archive-raw-run/1",
    runId: value.rawRunId,
    migrationComplete: true,
    legacyB2Prefix: "news-archive/v1/wsj/2020-2020/wayback",
    hfPrefix: "raw/archive/v1/wsj/2020-2020/wayback",
    source: { publisher: "wsj", window: "2020-2020", mode: "wayback" },
    sourceRevision: "9".repeat(40),
    phases,
    objects: { files: totalFiles, bytes: totalBytes },
  }));
}

describe("historical archive canonical bridge", () => {
  it("binds parser validation to the capture's exact Raw HTML reference", () => {
    const value = archiveInput();
    value.validation.sourceRawSha256 = "c".repeat(64);
    expect(() => parseArchiveCanonicalInput(value)).toThrow(
      "historical Raw HTML provenance does not match the capture",
    );
  });

  it("uses only parser-approved images and preserves their exact body position", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "jojo-archive-canonical-"));
    await writeRawRunManifest(workspace);
    const image = Buffer.from("editorial-image");
    const download = vi.fn(async (url: string) => url.endsWith("best.jpg")
      ? { body: image, mediaType: "image/jpeg" }
      : undefined);
    const prepared = await prepareArchiveRow({
      value: archiveInput(),
      sources: [],
      workspace,
      download,
      imageConcurrency: 2,
    });

    expect(download).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith("https://images.wsj.net/best.jpg", expect.any(String));
    expect(prepared.candidate).toMatchObject({
      sourceId: "wsj",
      sourceName: "The Wall Street Journal",
      language: "en",
      canonicalUrl: "https://www.wsj.com/articles/example",
      authors: ["Reporter One"],
      parserVersion: "wsj-parser/0.1.99",
      rawPageObject: archiveInput().recordObject,
      assets: [{
        role: "content",
        sourceUrl: "https://images.wsj.net/original.jpg",
        caption: "A single caption.",
        credit: "Archive Photographer",
        sha256: createHash("sha256").update(image).digest("hex"),
      }],
    });
    const body = prepared.candidate.processedBody!;
    expect(body).toContain("<p>Opening <strong>paragraph</strong> with an unsafe link.</p>");
    expect(body.indexOf("<p>")).toBeLessThan(body.indexOf("<figure"));
    expect(body.indexOf("<figure")).toBeLessThan(body.indexOf("<ul>"));
    expect(body.match(/A single caption\./gu)).toHaveLength(1);
    expect(body).not.toContain("javascript:");
    expect(body).not.toContain("<script");
    expect(body).toContain("<li>Country — Value</li>");
    expect(archiveAssetObjects([prepared])).toEqual([prepared.candidate.assets![0]!.rawObject]);
    await expect(readFile(path.join(workspace, ...prepared.candidate.assets![0]!.rawObject.split("/"))))
      .resolves.toEqual(image);
  });

  it("checks each Canonical input against its Raw run even when the manifest is cached", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "jojo-archive-revision-"));
    await writeRawRunManifest(workspace);
    const runManifestValidationCache = new Map();
    await prepareArchiveRow({
      value: archiveInput(),
      sources: [],
      workspace,
      runManifestValidationCache,
      download: async () => undefined,
    });
    await expect(prepareArchiveRow({
      value: archiveInput({ rawRunId: "different-run" }),
      sources: [],
      workspace,
      runManifestValidationCache,
      download: async () => undefined,
    })).rejects.toThrow("historical Raw run manifest does not match the Canonical input");
  });

  it("rejects a Raw run without a completion summary", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "jojo-archive-incomplete-"));
    await writeRawRunManifest(workspace, archiveInput(), { emptyCompletion: true });
    await expect(prepareArchiveRow({
      value: archiveInput(),
      sources: [],
      workspace,
      download: async () => undefined,
    })).rejects.toThrow("historical Raw run has no completion summary");
  });

  it("rejects a completion file set containing an object from another phase", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "jojo-archive-wrong-phase-"));
    await writeRawRunManifest(workspace, archiveInput(), { wrongCompletion: true });
    await expect(prepareArchiveRow({
      value: archiveInput(),
      sources: [],
      workspace,
      download: async () => undefined,
    })).rejects.toThrow("completion file set contains an invalid object");
  });

  it("reuses verified dependent image bytes without a network request", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "jojo-archive-dependent-"));
    await writeRawRunManifest(workspace);
    const body = Buffer.from("stored-image");
    const compressed = gzipSync(body);
    const blobPath = "objects/image/aa/stored.jpg.gz";
    const file = path.join(workspace, "raw", "archive", "v1", "wsj", "2020-2020", "wayback", "raw", ...blobPath.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, compressed);
    const value = archiveInput();
    value.captureRecord.dependentResources = [{
      sourceUrl: "https://images.wsj.net/best.jpg",
      snapshotUrl: "https://web.archive.org/image.jpg",
      contentType: "image/jpeg",
      blob: {
        path: blobPath,
        sha256: createHash("sha256").update(body).digest("hex"),
        byteCount: body.byteLength,
        storedByteCount: compressed.byteLength,
        contentEncoding: "gzip",
      },
    }];
    const download = vi.fn(async () => undefined);
    const prepared = await prepareArchiveRow({ value, sources: [], workspace, download });
    expect(download).not.toHaveBeenCalled();
    expect(prepared.candidate.assets?.[0]?.size).toBe(body.byteLength);
  });

  it("omits failed images while retaining article text", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "jojo-archive-no-image-"));
    await writeRawRunManifest(workspace);
    const prepared = await prepareArchiveRow({
      value: archiveInput(), sources: [], workspace, download: async () => undefined,
    });
    expect(prepared.candidate.assets).toEqual([]);
    expect(prepared.candidate.processedBody).toContain("Opening");
    expect(prepared.candidate.processedBody).not.toContain("<figure");
  });

  it("writes Times article/2 and merges the existing date index", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "jojo-archive-write-"));
    await writeRawRunManifest(workspace);
    const prepared = await prepareArchiveRow({
      value: archiveInput(), sources: [], workspace,
      download: async () => ({ body: Buffer.from("image"), mediaType: "image/jpeg" }),
    });
    const dateObject = affectedCanonicalDateObjects([prepared])[0]!;
    const dateFile = path.join(workspace, ...dateObject.split("/"));
    await mkdir(path.dirname(dateFile), { recursive: true });
    await writeFile(dateFile, gzipSync(JSON.stringify({
      formatVersion: "jojo-news-date/1",
      source: { id: "wsj", name: "The Wall Street Journal", language: "en" },
      issueDate: "2020-01-02",
      updatedAt: "2026-08-29T00:00:00Z",
      articles: [{
        articleId: "wsj:existing",
        object: "canonical/wsj/articles/existing.json.gz",
        contentHash: "existing",
        publishedAt: "2020-01-02T11:00:00Z",
      }],
    })));

    const results = await writeArchiveCanonical({
      workspace, rows: [prepared], sources: [], rawRevision: "c".repeat(40),
    });
    expect(results).toHaveLength(1);
    const articleFile = path.join(workspace, ...results[0]!.articles[0]!.object.split("/"));
    const article = JSON.parse(gunzipSync(await readFile(articleFile)).toString("utf8")) as Record<string, any>;
    expect(article).toMatchObject({
      formatVersion: "jojo-news-article/2",
      source: { id: "wsj", name: "The Wall Street Journal" },
      provenance: {
        rawRevision: "c".repeat(40),
        rawRunId: "archive-run-1",
        rawManifest: archiveInput().rawRunManifest,
        rawPage: archiveInput().recordObject,
        parserVersion: "wsj-parser/0.1.99",
        discovery: { kind: "historical-archive", providers: ["wayback"], recordCount: 1 },
      },
    });
    const date = JSON.parse(gunzipSync(await readFile(dateFile)).toString("utf8")) as { articles: Array<{ articleId: string }> };
    expect(date.articles.map((row) => row.articleId)).toContain("wsj:existing");
    expect(date.articles.map((row) => row.articleId)).toContain(prepared.candidate.articleId);
  });

  it("deduplicates normalized URLs deterministically and has explicit archive-only sources", () => {
    expect(archiveSourceConfig("nikkei-japan", [])).toMatchObject({ name: "Nikkei", language: "ja" });
    const weak = {
      formatVersion: "jojo-news-canonical-prepared/1" as const,
      sourceRawRevision: "a",
      rawRunId: "run",
      rawRunManifest: "raw/archive/run.json",
      recordObject: "raw/archive/v1/weak.json",
      provider: "wayback",
      retrievedAt: "2026-01-01T00:00:00Z",
      candidate: {
        articleId: "wsj:weak", sourceId: "wsj", sourceName: "WSJ", language: "en",
        sourceUrl: "https://www.wsj.com/a", canonicalUrl: "https://www.wsj.com/a?utm_source=x",
        title: "A", contentStatus: "full" as const, publishedAt: "2020-01-01T00:00:00Z",
        authors: [], publisherCategories: [], processedBody: "<p>Short.</p>",
      },
    };
    const strong = {
      ...weak,
      recordObject: "raw/archive/v1/strong.json",
      candidate: { ...weak.candidate, articleId: "wsj:strong", canonicalUrl: "https://www.wsj.com/a", processedBody: `<p>${"Long ".repeat(100)}</p>` },
    };
    expect(deduplicatePreparedRows([weak, strong])).toEqual([strong]);
  });

  it("creates a deterministic prepared batch and exact empty asset manifest", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "jojo-archive-cli-"));
    const inputFile = path.join(workspace, "input.jsonl");
    const preparedFile = path.join(workspace, "prepared.jsonl.gz");
    const manifestFile = path.join(workspace, "asset-files.json");
    const value = archiveInput();
    await writeRawRunManifest(workspace, value);
    value.parserResult.images = [];
    value.parserResult.blocks = value.parserResult.blocks.filter((block) => block.type !== "image");
    await writeFile(inputFile, `${JSON.stringify(value)}\n`);
    const result = await runArchiveCanonical(new Map([
      ["action", "prepare"],
      ["input", inputFile],
      ["output", workspace],
      ["config", fileURLToPath(new URL("../sources.v2.json", import.meta.url))],
      ["replay-revision", value.rawRevision],
      ["prepared-output", preparedFile],
      ["asset-manifest", manifestFile],
    ]));
    expect(result).toMatchObject({ inputs: 1, articles: 1, assets: 0 });
    expect(JSON.parse(await readFile(manifestFile, "utf8"))).toEqual({
      formatVersion: "jojo-hf-file-set/1",
      files: [],
    });
    const prepared = JSON.parse(gunzipSync(await readFile(preparedFile)).toString("utf8")) as { formatVersion: string };
    expect(prepared.formatVersion).toBe("jojo-news-canonical-prepared/1");
  });
});
