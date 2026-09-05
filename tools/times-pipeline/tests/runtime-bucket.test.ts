import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createArchive, describeFiles, extractVerifiedArchive } from "../src/runtime-bucket/archive.js";
import { HfRuntimeBucket } from "../src/runtime-bucket/store.js";
import {
  publishRuntimeJob,
  publishRuntimeJobStatus,
  readRuntimeJob,
  restoreRuntimeJob,
  statusAfterSuccessfulDelivery,
  statusAfterRuntimeFailure,
} from "../src/runtime-bucket/jobs.js";
import { publishRuntimeMemory, restoreRuntimeMemory } from "../src/runtime-bucket/memory.js";
import {
  PROCESS_RESULT,
  assertRuntimeProcessGenerationUncommitted,
  promoteRuntimeProcess,
  restoreRuntimeProcess,
  stageRuntimeProcess,
} from "../src/runtime-bucket/process-generation.js";
import {
  enqueueRuntimeJob,
  selectRuntimeJob,
  selectRuntimeJobs,
  updateRuntimeQueueAfterDelivery,
} from "../src/runtime-bucket/queue.js";
import {
  pendingJobObjectName,
  PROCESS_MEMORY_OBJECT,
  type RuntimeJobStatus,
  type RuntimeObjectInfo,
  type RuntimeObjectStore,
} from "../src/runtime-bucket/types.js";

const hfHub = vi.hoisted(() => ({
  deleteFiles: vi.fn(),
  downloadFile: vi.fn(),
  listFiles: vi.fn(),
  pathsInfo: vi.fn(),
  uploadFiles: vi.fn(),
}));

vi.mock("@huggingface/hub", () => hfHub);

class MemoryStore implements RuntimeObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly uploads: string[] = [];
  readonly listedPrefixes: string[] = [];
  readonly failedUploads = new Set<string>();
  readonly failedDeletes = new Set<string>();

  async upload(objectName: string, localFile: string): Promise<void> {
    if (this.failedUploads.has(objectName)) throw new Error(`injected upload failure: ${objectName}`);
    this.objects.set(objectName, await readFile(localFile));
    this.uploads.push(objectName);
  }

  async download(objectName: string, localFile: string): Promise<boolean> {
    const body = this.objects.get(objectName);
    if (!body) return false;
    await mkdir(path.dirname(localFile), { recursive: true });
    await writeFile(localFile, body);
    return true;
  }

  async readText(objectName: string): Promise<string | null> {
    const body = this.objects.get(objectName);
    return body ? Buffer.from(body).toString("utf8") : null;
  }

  async info(objectName: string): Promise<RuntimeObjectInfo | null> {
    const body = this.objects.get(objectName);
    return body ? { objectName, size: body.byteLength } : null;
  }

  async list(prefix: string): Promise<RuntimeObjectInfo[]> {
    this.listedPrefixes.push(prefix);
    return [...this.objects].filter(([objectName]) => objectName.startsWith(prefix))
      .map(([objectName, body]) => ({ objectName, size: body.byteLength }));
  }

  async delete(objectNames: readonly string[]): Promise<void> {
    for (const objectName of objectNames) {
      if (this.failedDeletes.has(objectName)) throw new Error(`injected delete failure: ${objectName}`);
      this.objects.delete(objectName);
    }
  }
}

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "jojo-runtime-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function rawFixture(root: string): Promise<string> {
  const runId = "20260901T100000000Z-42";
  const sourceRoot = path.join(root, "raw", "ap", "runs", "2026", "09", "01", runId);
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "candidates.jsonl.gz"), gzipSync([
    JSON.stringify({ articleId: "ap:one", sourceId: "ap" }),
    JSON.stringify({ articleId: "ap:two", sourceId: "ap" }),
    "",
  ].join("\n")));
  const sourceManifest = path.relative(root, path.join(sourceRoot, "manifest.json")).split(path.sep).join("/");
  await writeFile(path.join(sourceRoot, "manifest.json"), `${JSON.stringify({ runId, sourceId: "ap" })}\n`);
  await mkdir(path.join(root, "raw", "ap"), { recursive: true });
  await writeFile(path.join(root, "raw", "ap", "state.json.gz"), gzipSync(JSON.stringify({ articles: {} })));
  const runManifest = path.join(root, "raw", "runs", "2026", "09", "01", `${runId}.json`);
  await mkdir(path.dirname(runManifest), { recursive: true });
  await writeFile(runManifest, `${JSON.stringify({
    runId,
    complete: true,
    sources: [{ sourceId: "ap", status: "ok", output: { manifest: sourceManifest } }],
  })}\n`);
  return runManifest;
}

describe("Runtime archive transport", () => {
  it("round-trips an exact file set and rejects unexpected archive entries", async () => {
    const source = await temporaryRoot();
    const output = await temporaryRoot();
    await mkdir(path.join(source, "raw", "ap"), { recursive: true });
    await writeFile(path.join(source, "raw", "ap", "one.txt"), "one");
    const files = await describeFiles(source);
    const archive = await createArchive(source, files, path.join(source, "job.tar"), false);
    await extractVerifiedArchive(archive.file, output, files);
    expect(await readFile(path.join(output, "raw", "ap", "one.txt"), "utf8")).toBe("one");

    await expect(extractVerifiedArchive(archive.file, output, [{
      path: "raw/ap/other.txt",
      size: 3,
      sha256: createHash("sha256").update("one").digest("hex"),
    }])).rejects.toThrow("unexpected file");
  });

  it("rejects hard-linked producer files", async () => {
    const source = await temporaryRoot();
    await writeFile(path.join(source, "original.txt"), "same inode");
    await link(path.join(source, "original.txt"), path.join(source, "alias.txt"));
    await expect(describeFiles(source)).rejects.toThrow("hard-linked");
  });

  it("enforces entry-count, per-file, and expanded-size limits before extraction", async () => {
    const source = await temporaryRoot();
    const output = await temporaryRoot();
    await writeFile(path.join(source, "one.txt"), "one");
    await writeFile(path.join(source, "two.txt"), "two");
    const files = await describeFiles(source);
    const archive = await createArchive(source, files, path.join(source, "limited.tar"), false);
    const firstFile = files[0];
    if (!firstFile) throw new Error("missing archive test fixture");

    await expect(extractVerifiedArchive(archive.file, output, [firstFile], { maxEntries: 1 }))
      .rejects.toThrow("more than 1 entries");
    await expect(extractVerifiedArchive(archive.file, output, files, { maxEntryBytes: 2 }))
      .rejects.toThrow("exceeds 2 bytes");
    await expect(extractVerifiedArchive(archive.file, output, files, { maxExpandedBytes: 5 }))
      .rejects.toThrow("beyond 5 bytes");
    await expect(stat(path.join(output, "one.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Runtime Bucket reads", () => {
  it("does not retry corrupt UTF-8 as a network TypeError", async () => {
    const bucket = new HfRuntimeBucket("jojo/runtime", "token");
    hfHub.downloadFile.mockResolvedValueOnce(new Blob([new Uint8Array([0xff])]));
    await expect(bucket.readText("times/status.json")).rejects.toThrow("not valid UTF-8");
    expect(hfHub.downloadFile).toHaveBeenCalledTimes(1);
  });

  it.each(["download", "readText"])("retries lazy Blob stream failures during %s", async (method) => {
    const root = await temporaryRoot();
    const file = path.join(root, "object.bin");
    await writeFile(file, "old");
    const bucket = new HfRuntimeBucket("jojo/runtime", "token");
    hfHub.downloadFile.mockResolvedValueOnce({
      size: 4,
      stream: () => new ReadableStream({
        start(controller) { controller.error(new TypeError("connection reset")); },
      }),
    }).mockResolvedValueOnce(new Blob(["done"]));
    const result = method === "download"
      ? await bucket.download("times/object.bin", file)
      : await bucket.readText("times/object.bin");
    expect(result).toBe(method === "download" ? true : "done");
    expect(await readFile(file, "utf8")).toBe(method === "download" ? "done" : "old");
    expect(await readdir(root)).toEqual(["object.bin"]);
    expect(hfHub.downloadFile).toHaveBeenCalledTimes(2);
  });

  it("allows a read-only Runtime root listing without weakening object paths", async () => {
    const bucket = new HfRuntimeBucket("jojo/runtime", "token");
    hfHub.listFiles.mockReturnValueOnce((async function* () {
      yield { type: "file", path: "times/pending-jobs.json", size: 4 };
      yield { type: "file", path: "times/pending/job-1.json", size: 5 };
    })());

    await expect(bucket.list("times")).resolves.toEqual([
      { objectName: "times/pending-jobs.json", size: 4 },
      { objectName: "times/pending/job-1.json", size: 5 },
    ]);
    await expect(bucket.readText("times")).rejects.toThrow("outside times/");
  });

  it("caps declared and streamed bytes for downloads and text", async () => {
    const root = await temporaryRoot();
    const bucket = new HfRuntimeBucket("jojo/runtime", "token");
    hfHub.downloadFile.mockResolvedValueOnce(new Blob(["four"]));
    await expect(bucket.download("times/object.bin", path.join(root, "object.bin"), { maxBytes: 3 }))
      .rejects.toThrow("3-byte download limit");

    hfHub.downloadFile.mockResolvedValueOnce({
      size: 2,
      stream: () => new Blob(["four"]).stream(),
    });
    await expect(bucket.download("times/changed.bin", path.join(root, "changed.bin"), { maxBytes: 3 }))
      .rejects.toThrow("while streaming");

    hfHub.downloadFile.mockResolvedValueOnce(new Blob(["four"]));
    await expect(bucket.readText("times/status.json", { maxBytes: 3 }))
      .rejects.toThrow("3-byte download limit");
    await expect(stat(path.join(root, "object.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(root, "changed.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Runtime jobs", () => {
  it("does not swallow transport failures as an empty queue", async () => {
    const store = new MemoryStore();
    store.objects.set("times/pending/unreadable.json", Buffer.from("{}"));
    const original = store.readText.bind(store);
    store.readText = async (objectName) => {
      if (objectName === "times/jobs/unreadable/status.json") throw new Error("HTTP 429 exhausted");
      return original(objectName);
    };
    await expect(selectRuntimeJobs({ store, workDirectory: await temporaryRoot() }))
      .rejects.toThrow("HTTP 429 exhausted");
  });

  it("surfaces failed recovery marker writes and keeps the job retryable", async () => {
    const store = new MemoryStore();
    const output = await temporaryRoot();
    const workDirectory = await temporaryRoot();
    await publishRuntimeJob({ store, output, runManifest: await rawFixture(output), jobId: "recover", workDirectory });
    store.failedUploads.add(pendingJobObjectName("recover"));
    await expect(selectRuntimeJobs({ store, workDirectory })).rejects.toThrow("injected upload failure");
    store.failedUploads.clear();
    expect((await selectRuntimeJobs({ store, workDirectory })).map((job) => job.jobId)).toEqual(["recover"]);
  });

  it("publishes Raw before the ready marker, restores exact bytes, and preserves retryable articles", async () => {
    const output = await temporaryRoot();
    const restored = await temporaryRoot();
    const work = await temporaryRoot();
    const runManifest = await rawFixture(output);
    const store = new MemoryStore();
    const status = await publishRuntimeJob({
      store,
      output,
      runManifest,
      jobId: "42",
      workDirectory: work,
      now: new Date("2026-09-01T10:01:00.000Z"),
    });
    expect(store.uploads).toEqual(["times/jobs/42/raw.tar", "times/jobs/42/status.json"]);
    expect(status.state).toBe("ready");
    expect(status.articles.pending).toHaveLength(2);

    const downloaded = await restoreRuntimeJob({ store, output: restored, jobId: "42", workDirectory: work });
    expect(downloaded.runId).toBe("20260901T100000000Z-42");
    expect(await stat(path.join(restored, ...downloaded.runManifest.split("/")))).toBeTruthy();

    const partial = statusAfterSuccessfulDelivery(status, {
      sources: [{
        sourceId: "ap",
        articles: [{ articleId: "ap:one" }],
        unchangedArticles: [],
        skippedArticles: [],
        processingFailures: [{ articleId: "ap:two", error: "publisher parser crashed" }],
      }],
    }, new Date("2026-09-01T10:05:00.000Z"));
    expect(partial).toMatchObject({
      state: "partial",
      attempts: 1,
      articles: { total: 2, completed: 1, excluded: 0, pending: [{ sourceId: "ap", articleId: "ap:two" }] },
    });
    await publishRuntimeJobStatus({ store, status: partial, workDirectory: work });
    expect((await readRuntimeJob(store, "42"))?.state).toBe("partial");

    const done = statusAfterSuccessfulDelivery(partial, {
      sources: [{ sourceId: "ap", articles: [{ articleId: "ap:two" }], unchangedArticles: [], skippedArticles: [], processingFailures: [] }],
    });
    expect(done).toMatchObject({ state: "done", attempts: 2, articles: { total: 2, completed: 2, excluded: 0, pending: [] } });
  });

  it("detects a corrupted Raw archive before extraction", async () => {
    const output = await temporaryRoot();
    const restored = await temporaryRoot();
    const work = await temporaryRoot();
    const store = new MemoryStore();
    await publishRuntimeJob({ store, output, runManifest: await rawFixture(output), jobId: "43", workDirectory: work });
    store.objects.set("times/jobs/43/raw.tar", Buffer.from("corrupt"));
    await expect(restoreRuntimeJob({ store, output: restored, jobId: "43", workDirectory: work }))
      .rejects.toThrow(/size mismatch|SHA-256 mismatch/u);
  });

  it("does not overwrite an immutable job and accepts only an exact initial retry", async () => {
    const output = await temporaryRoot();
    const work = await temporaryRoot();
    const store = new MemoryStore();
    const runManifest = await rawFixture(output);
    const first = await publishRuntimeJob({ store, output, runManifest, jobId: "immutable", workDirectory: work });
    const exact = await publishRuntimeJob({ store, output, runManifest, jobId: "immutable", workDirectory: work });
    expect(exact.raw.sha256).toBe(first.raw.sha256);

    await writeFile(path.join(output, "raw", "ap", "state.json.gz"), gzipSync(JSON.stringify({ changed: true })));
    await expect(publishRuntimeJob({ store, output, runManifest, jobId: "immutable", workDirectory: work }))
      .rejects.toThrow("different or advanced state");
  });

  it("keeps unfinished jobs in a durable queue and backs off partial retries", async () => {
    const output = await temporaryRoot();
    const work = await temporaryRoot();
    const store = new MemoryStore();
    const runManifest = await rawFixture(output);
    const first = await publishRuntimeJob({
      store, output, runManifest, jobId: "queue-1", workDirectory: work,
      now: new Date("2026-09-01T10:00:00.000Z"),
    });
    await enqueueRuntimeJob({ store, status: first, workDirectory: work, now: new Date("2026-09-01T10:00:01.000Z") });
    const partial = statusAfterSuccessfulDelivery(first, {
      sources: [{
        sourceId: "ap", articles: [{ articleId: "ap:one" }], unchangedArticles: [], skippedArticles: [],
        processingFailures: [{ articleId: "ap:two", error: "parser bug" }],
      }],
    }, new Date("2026-09-01T10:05:00.000Z"));
    await publishRuntimeJobStatus({ store, status: partial, workDirectory: work });
    await updateRuntimeQueueAfterDelivery({ store, status: partial, workDirectory: work, now: new Date("2026-09-01T10:05:00.000Z") });

    expect(await selectRuntimeJob({ store, workDirectory: work, now: new Date("2026-09-01T10:10:00.000Z") })).toBeNull();
    expect((await selectRuntimeJob({ store, workDirectory: work, now: new Date("2026-09-01T10:15:00.000Z") }))?.jobId)
      .toBe("queue-1");

    const done = statusAfterSuccessfulDelivery(partial, {
      sources: [{
        sourceId: "ap", articles: [{ articleId: "ap:two" }], unchangedArticles: [], skippedArticles: [], processingFailures: [],
      }],
    }, new Date("2026-09-01T10:16:00.000Z"));
    await publishRuntimeJobStatus({ store, status: done, workDirectory: work });
    await updateRuntimeQueueAfterDelivery({ store, status: done, workDirectory: work, now: new Date("2026-09-01T10:16:00.000Z") });
    expect(await selectRuntimeJob({ store, workDirectory: work, now: new Date("2026-09-01T10:30:00.000Z") })).toBeNull();
  });

  it("migrates a missing or corrupt legacy queue to per-job pending markers", async () => {
    const output = await temporaryRoot();
    const work = await temporaryRoot();
    const store = new MemoryStore();
    const status = await publishRuntimeJob({
      store, output, runManifest: await rawFixture(output), jobId: "orphan-ready", workDirectory: work,
    });
    expect((await selectRuntimeJob({ store, workDirectory: work }))?.jobId).toBe(status.jobId);
    store.objects.set("times/pending-jobs.json", Buffer.from("not-json"));
    expect((await selectRuntimeJob({ store, workDirectory: work }))?.jobId).toBe(status.jobId);
    expect(store.objects.has(pendingJobObjectName("orphan-ready"))).toBe(true);
    expect(Buffer.from(store.objects.get("times/pending-jobs.json")!).toString("utf8")).toBe("not-json");
  });

  it("selects several ready jobs in FIFO order without a shared queue write", async () => {
    const work = await temporaryRoot();
    const store = new MemoryStore();
    for (const [index, jobId] of ["batch-3", "batch-1", "batch-2"].entries()) {
      const output = await temporaryRoot();
      const ready = await publishRuntimeJob({
        store,
        output,
        runManifest: await rawFixture(output),
        jobId,
        workDirectory: work,
        now: new Date(`2026-09-01T10:0${index}:00.000Z`),
      });
      await enqueueRuntimeJob({ store, status: ready, workDirectory: work });
    }

    const selected = await selectRuntimeJobs({ store, workDirectory: work, maxJobs: 2 });
    expect(selected.map((status) => status.jobId)).toEqual(["batch-3", "batch-1"]);
    expect(store.listedPrefixes).toEqual(["times"]);
    expect(store.objects.has("times/pending-jobs.json")).toBe(false);
    expect(selected.every((status) => store.objects.has(pendingJobObjectName(status.jobId)))).toBe(true);
  });

  it("backs off a whole-job Runtime failure so newer ready work can continue", async () => {
    const output = await temporaryRoot();
    const work = await temporaryRoot();
    const store = new MemoryStore();
    const failed = await publishRuntimeJob({
      store, output, runManifest: await rawFixture(output), jobId: "poison", workDirectory: work,
      now: new Date("2026-09-01T10:00:00.000Z"),
    });
    await enqueueRuntimeJob({ store, status: failed, workDirectory: work });
    const deferred = statusAfterRuntimeFailure(failed, "raw hash mismatch", new Date("2026-09-01T10:01:00.000Z"));
    await publishRuntimeJobStatus({ store, status: deferred, workDirectory: work });
    await updateRuntimeQueueAfterDelivery({ store, status: deferred, workDirectory: work });

    const newerOutput = await temporaryRoot();
    const newer = await publishRuntimeJob({
      store, output: newerOutput, runManifest: await rawFixture(newerOutput), jobId: "newer", workDirectory: work,
      now: new Date("2026-09-01T10:02:00.000Z"),
    });
    await enqueueRuntimeJob({ store, status: newer, workDirectory: work });
    expect((await selectRuntimeJob({ store, workDirectory: work, now: new Date("2026-09-01T10:05:00.000Z") }))?.jobId)
      .toBe("newer");
  });

  it("keeps one staged Process transaction ahead of partial and exact selections", async () => {
    const work = await temporaryRoot();
    const store = new MemoryStore();
    const stagedOutput = await temporaryRoot();
    const partialOutput = await temporaryRoot();
    const stagedBase = await publishRuntimeJob({
      store,
      output: stagedOutput,
      runManifest: await rawFixture(stagedOutput),
      jobId: "staged-head",
      workDirectory: work,
      now: new Date("2026-09-01T10:00:00.000Z"),
    });
    const partialBase = await publishRuntimeJob({
      store,
      output: partialOutput,
      runManifest: await rawFixture(partialOutput),
      jobId: "partial-other",
      workDirectory: work,
      now: new Date("2026-09-01T10:01:00.000Z"),
    });
    const withStagedProcess = (status: RuntimeJobStatus): RuntimeJobStatus => ({
      ...status,
      stagedProcess: {
        objectName: `times/jobs/${status.jobId}/processed-${"a".repeat(64)}.tar.gz`,
        createdAt: "2026-09-01T10:02:00.000Z",
        size: 1,
        sha256: "a".repeat(64),
        files: [
          { path: "runtime/memory.json", size: 1, sha256: "b".repeat(64) },
          { path: "runtime/process-result.json", size: 1, sha256: "c".repeat(64) },
        ],
      },
    });
    const staged = withStagedProcess(stagedBase);
    const partial = statusAfterRuntimeFailure(partialBase, "retry later", new Date("2026-09-01T10:02:00.000Z"));
    await publishRuntimeJobStatus({ store, status: staged, workDirectory: work });
    await publishRuntimeJobStatus({ store, status: partial, workDirectory: work });
    await enqueueRuntimeJob({ store, status: staged, workDirectory: work });
    await enqueueRuntimeJob({ store, status: partial, workDirectory: work });

    expect((await selectRuntimeJob({ store, workDirectory: work, now: new Date("2026-09-01T10:30:00.000Z") }))?.jobId)
      .toBe("staged-head");
    await expect(selectRuntimeJob({
      store,
      workDirectory: work,
      preferredJobId: "partial-other",
      exactPreferred: true,
    })).rejects.toThrow("cannot bypass staged Process job staged-head");
    expect((await selectRuntimeJob({
      store,
      workDirectory: work,
      preferredJobId: "staged-head",
      exactPreferred: true,
    }))?.jobId).toBe("staged-head");

    await publishRuntimeJobStatus({ store, status: withStagedProcess(partial), workDirectory: work });
    await expect(selectRuntimeJob({ store, workDirectory: work }))
      .rejects.toThrow("multiple staged Process jobs");
  });
});

describe("Runtime memories", () => {
  it("restores capture memory without carrying run payloads", async () => {
    const output = await temporaryRoot();
    const restored = await temporaryRoot();
    const work = await temporaryRoot();
    const store = new MemoryStore();
    await rawFixture(output);
    const published = await publishRuntimeMemory({
      store,
      output,
      workDirectory: work,
      kind: "capture",
      basedOnJobId: "44",
      now: new Date("2026-09-01T10:00:00.000Z"),
    });
    expect(published.files).toBe(1);
    const result = await restoreRuntimeMemory({ store, output: restored, workDirectory: work, kind: "capture" });
    expect(result).toMatchObject({ restored: true, basedOnJobId: "44", files: 1 });
    expect(await stat(path.join(restored, "raw", "ap", "state.json.gz"))).toBeTruthy();
    await expect(stat(path.join(restored, "raw", "runs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an over-budget memory archive before unpacking", async () => {
    const output = await temporaryRoot();
    const restored = await temporaryRoot();
    const work = await temporaryRoot();
    const store = new MemoryStore();
    await rawFixture(output);
    await publishRuntimeMemory({
      store,
      output,
      workDirectory: work,
      kind: "capture",
      basedOnJobId: "memory-limit",
    });
    await expect(restoreRuntimeMemory({
      store,
      output: restored,
      workDirectory: work,
      kind: "capture",
      archiveLimits: { maxEntries: 1 },
    })).rejects.toThrow("more than 1 entries");
    await expect(stat(path.join(restored, "raw", "ap", "state.json.gz"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stages an immutable Process generation and promotes only its small committed pointer", async () => {
    const output = await temporaryRoot();
    const restored = await temporaryRoot();
    const work = await temporaryRoot();
    const store = new MemoryStore();
    const ready = await publishRuntimeJob({
      store,
      output,
      runManifest: await rawFixture(output),
      jobId: "45",
      workDirectory: work,
      now: new Date("2026-09-01T10:00:00.000Z"),
    });
    const assetObject = "raw/ap/assets/image.jpg";
    const articleObject = `canonical/ap/articles/${"a".repeat(64)}.json.gz`;
    const dateObject = "canonical/ap/dates/2026/09/2026-09-01.json.gz";
    for (const objectName of [assetObject, articleObject, dateObject, "canonical/ap/dataset.json"]) {
      await mkdir(path.dirname(path.join(output, ...objectName.split("/"))), { recursive: true });
    }
    await writeFile(path.join(output, ...assetObject.split("/")), "image");
    await writeFile(path.join(output, ...articleObject.split("/")), gzipSync(JSON.stringify({ assets: [{ rawObject: assetObject }] })));
    await writeFile(path.join(output, ...dateObject.split("/")), gzipSync(JSON.stringify({ articles: [{ object: articleObject }] })));
    await writeFile(path.join(output, "canonical", "ap", "dataset.json"), "{}\n");
    await mkdir(path.join(output, "canonical", "ap", "dates", "2026", "08"), { recursive: true });
    await writeFile(path.join(output, "canonical", "ap", "dates", "2026", "08", "2026-08-01.json.gz"), gzipSync(JSON.stringify({ articles: [] })));
    const processResult = path.join(work, "process-result.json");
    await writeFile(processResult, `${JSON.stringify({
      sources: [{
        sourceId: "ap",
        articles: [{ articleId: "ap:one" }, { articleId: "ap:two" }],
        unchangedArticles: [],
        skippedArticles: [],
        processingFailures: [],
      }],
    })}\n`);

    const staged = await stageRuntimeProcess({
      store,
      output,
      workDirectory: work,
      status: ready,
      jobIds: ["45", "46"],
      processResultFile: processResult,
      now: new Date("2026-09-01T12:00:00.000Z"),
      retentionDays: 8,
    });
    expect(staged.stagedProcess?.files.map((file) => file.path)).toContain(PROCESS_RESULT);
    expect(staged.stagedProcess?.jobIds).toEqual(["45", "46"]);
    expect(statusAfterRuntimeFailure(staged, "B2 temporarily unavailable").state).toBe("ready");
    await publishRuntimeJobStatus({ store, status: staged, workDirectory: work });
    const replay = await restoreRuntimeProcess({ store, output: restored, workDirectory: work, status: staged });
    expect(replay).toMatchObject({
      restored: true,
      replay: true,
      basedOnJobId: "45",
      jobIds: ["45", "46"],
    });
    expect(await readFile(path.join(restored, ...assetObject.split("/")), "utf8")).toBe("image");
    await expect(stat(path.join(restored, "canonical", "ap", "dates", "2026", "08", "2026-08-01.json.gz")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await promoteRuntimeProcess({ store, status: staged, workDirectory: work, now: new Date("2026-09-01T12:01:00.000Z") });

    const nextOutput = await temporaryRoot();
    const next = await publishRuntimeJob({
      store,
      output: nextOutput,
      runManifest: await rawFixture(nextOutput),
      jobId: "46",
      workDirectory: work,
    });
    const committed = await restoreRuntimeProcess({ store, output: nextOutput, workDirectory: work, status: next });
    expect(committed).toMatchObject({ restored: true, replay: false, basedOnJobId: "45" });
  });

  it("reuses a full Process base through bounded cumulative deltas", async () => {
    const output = await temporaryRoot();
    const work = await temporaryRoot();
    const store = new MemoryStore();
    const firstReady = await publishRuntimeJob({
      store,
      output,
      runManifest: await rawFixture(output),
      jobId: "delta-1",
      workDirectory: work,
    });
    const assetObject = "raw/ap/assets/large.jpg";
    const articleObject = `canonical/ap/articles/${"c".repeat(64)}.json.gz`;
    const dateObject = "canonical/ap/dates/2026/09/2026-09-01.json.gz";
    const translationObject = `canonical/ap/translations/en/2026/09/2026-09-01/${"d".repeat(64)}.json.gz`;
    for (const objectName of [assetObject, articleObject, dateObject, translationObject, "canonical/ap/dataset.json"]) {
      await mkdir(path.dirname(path.join(output, ...objectName.split("/"))), { recursive: true });
    }
    const largeAsset = randomBytes(20_000);
    await writeFile(path.join(output, ...assetObject.split("/")), largeAsset);
    await writeFile(path.join(output, ...articleObject.split("/")), gzipSync(JSON.stringify({ assets: [{ rawObject: assetObject }] })));
    await writeFile(path.join(output, ...dateObject.split("/")), gzipSync(JSON.stringify({ articles: [{ object: articleObject }] })));
    await writeFile(path.join(output, ...translationObject.split("/")), gzipSync(JSON.stringify({ translated: true })));
    await writeFile(path.join(output, "canonical", "ap", "dataset.json"), "{\"revision\":1}\n");
    const firstResultFile = path.join(work, "delta-result-1.json");
    await writeFile(firstResultFile, "{\"sources\":[]}\n");
    const first = await stageRuntimeProcess({
      store,
      output,
      workDirectory: work,
      status: firstReady,
      processResultFile: firstResultFile,
      now: new Date("2026-09-01T10:00:00.000Z"),
    });
    expect(first.stagedProcess?.base).toBeUndefined();
    await promoteRuntimeProcess({ store, status: first, workDirectory: work });
    const baseObject = first.stagedProcess!.objectName;

    const secondOutput = await temporaryRoot();
    const secondReady = await publishRuntimeJob({
      store,
      output: secondOutput,
      runManifest: await rawFixture(secondOutput),
      jobId: "delta-2",
      workDirectory: work,
    });
    await restoreRuntimeProcess({ store, output: secondOutput, workDirectory: work, status: secondReady });
    await writeFile(path.join(secondOutput, "canonical", "ap", "dataset.json"), "{\"revision\":2}\n");
    await rm(path.join(secondOutput, ...translationObject.split("/")));
    const secondResultFile = path.join(work, "delta-result-2.json");
    await writeFile(secondResultFile, "{\"sources\":[{\"sourceId\":\"ap\"}]}\n");
    const second = await stageRuntimeProcess({
      store,
      output: secondOutput,
      workDirectory: work,
      status: secondReady,
      processResultFile: secondResultFile,
      now: new Date("2026-09-01T10:05:00.000Z"),
    });
    expect(second.stagedProcess).toMatchObject({
      base: { objectName: baseObject },
      deltaDepth: 1,
    });
    expect(second.stagedProcess?.files.map((file) => file.path)).not.toContain(assetObject);
    expect(second.stagedProcess?.stateFiles?.map((file) => file.path)).toContain(assetObject);
    expect(second.stagedProcess?.stateFiles?.map((file) => file.path)).not.toContain(translationObject);
    expect(second.stagedProcess!.size).toBeLessThan(first.stagedProcess!.size / 2);

    const replayOutput = await temporaryRoot();
    await restoreRuntimeProcess({ store, output: replayOutput, workDirectory: work, status: second });
    expect(await readFile(path.join(replayOutput, ...assetObject.split("/")))).toEqual(largeAsset);
    expect(await readFile(path.join(replayOutput, "canonical", "ap", "dataset.json"), "utf8")).toBe("{\"revision\":2}\n");
    await expect(stat(path.join(replayOutput, ...translationObject.split("/"))))
      .rejects.toMatchObject({ code: "ENOENT" });

    await promoteRuntimeProcess({ store, status: second, workDirectory: work });
    expect(store.objects.has(baseObject)).toBe(true);
    const secondObject = second.stagedProcess!.objectName;

    const thirdOutput = await temporaryRoot();
    const thirdReady = await publishRuntimeJob({
      store,
      output: thirdOutput,
      runManifest: await rawFixture(thirdOutput),
      jobId: "delta-3",
      workDirectory: work,
    });
    await restoreRuntimeProcess({ store, output: thirdOutput, workDirectory: work, status: thirdReady });
    await writeFile(path.join(thirdOutput, "canonical", "ap", "dataset.json"), "{\"revision\":3}\n");
    const thirdResultFile = path.join(work, "delta-result-3.json");
    await writeFile(thirdResultFile, "{\"sources\":[{\"sourceId\":\"ap\",\"revision\":3}]}\n");
    const third = await stageRuntimeProcess({
      store,
      output: thirdOutput,
      workDirectory: work,
      status: thirdReady,
      processResultFile: thirdResultFile,
      now: new Date("2026-09-01T10:10:00.000Z"),
    });
    expect(third.stagedProcess).toMatchObject({
      base: { objectName: baseObject },
      deltaDepth: 2,
    });
    await promoteRuntimeProcess({ store, status: third, workDirectory: work });
    expect(store.objects.has(baseObject)).toBe(true);
    expect(store.objects.has(secondObject)).toBe(false);
  });

  it("never overwrites the committed generation during a partial-job retry", async () => {
    const output = await temporaryRoot();
    const work = await temporaryRoot();
    const store = new MemoryStore();
    const ready = await publishRuntimeJob({
      store,
      output,
      runManifest: await rawFixture(output),
      jobId: "partial-generation",
      workDirectory: work,
      now: new Date("2026-09-01T10:00:00.000Z"),
    });
    const dataset = path.join(output, "canonical", "ap", "dataset.json");
    await mkdir(path.dirname(dataset), { recursive: true });
    await writeFile(dataset, "{\"revision\":1}\n");
    const processResultFile = path.join(work, "partial-process-result.json");
    const firstResult = {
      sources: [{
        sourceId: "ap",
        articles: [{ articleId: "ap:one" }],
        unchangedArticles: [],
        skippedArticles: [],
        processingFailures: [{ articleId: "ap:two", error: "retry" }],
      }],
    };
    await writeFile(processResultFile, `${JSON.stringify(firstResult)}\n`);
    const firstStaged = await stageRuntimeProcess({
      store,
      output,
      workDirectory: work,
      status: ready,
      processResultFile,
      now: new Date("2026-09-01T10:01:00.000Z"),
    });
    const firstObject = firstStaged.stagedProcess?.objectName;
    if (!firstObject) throw new Error("first Process generation was not staged");
    expect(firstObject).toMatch(/^times\/jobs\/partial-generation\/processed-[a-f0-9]{64}\.tar\.gz$/u);
    await promoteRuntimeProcess({ store, status: firstStaged, workDirectory: work });
    const firstBytes = store.objects.get(firstObject)?.slice();
    const partial = statusAfterSuccessfulDelivery(firstStaged, firstResult);
    expect(partial.state).toBe("partial");
    expect(partial.stagedProcess).toBeUndefined();

    await writeFile(dataset, "{\"revision\":2}\n");
    const secondResult = {
      sources: [{
        sourceId: "ap",
        articles: [{ articleId: "ap:two" }],
        unchangedArticles: [],
        skippedArticles: [],
        processingFailures: [],
      }],
    };
    await writeFile(processResultFile, `${JSON.stringify(secondResult)}\n`);
    const secondStaged = await stageRuntimeProcess({
      store,
      output,
      workDirectory: work,
      status: partial,
      processResultFile,
      now: new Date("2026-09-01T10:02:00.000Z"),
    });
    const secondObject = secondStaged.stagedProcess?.objectName;
    if (!secondObject) throw new Error("second Process generation was not staged");
    expect(secondObject).not.toBe(firstObject);
    expect(store.objects.get(firstObject)).toEqual(firstBytes);
    expect(JSON.parse((await store.readText(PROCESS_MEMORY_OBJECT))!).generation.objectName).toBe(firstObject);
    await expect(assertRuntimeProcessGenerationUncommitted(store, firstObject)).rejects.toThrow("committed");
    await expect(assertRuntimeProcessGenerationUncommitted(store, secondObject)).resolves.toBeUndefined();

    store.failedUploads.add(PROCESS_MEMORY_OBJECT);
    await expect(promoteRuntimeProcess({ store, status: secondStaged, workDirectory: work }))
      .rejects.toThrow("injected upload failure");
    store.failedUploads.clear();
    expect(JSON.parse((await store.readText(PROCESS_MEMORY_OBJECT))!).generation.objectName).toBe(firstObject);
    expect(store.objects.get(firstObject)).toEqual(firstBytes);

    store.failedDeletes.add(firstObject);
    await expect(promoteRuntimeProcess({ store, status: secondStaged, workDirectory: work }))
      .rejects.toThrow("injected delete failure");
    expect(JSON.parse((await store.readText(PROCESS_MEMORY_OBJECT))!).generation.objectName).toBe(secondObject);
    expect(store.objects.has(firstObject)).toBe(true);
    expect(store.objects.has(secondObject)).toBe(true);
    await expect(assertRuntimeProcessGenerationUncommitted(store, secondObject)).rejects.toThrow("committed");
  });
});
