import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JojoCatalog, TimesSourceIndex, TimesTimelineDay, TimesTimelineIndex } from "@jojo/content";
import { afterAll, describe, expect, it } from "vitest";
import { buildNewsDelivery, readJoxJson } from "../src/delivery-writer.js";
import { runProcess } from "../src/process-cli.js";
import {
  publishRuntimeJob,
  publishRuntimeJobStatus,
  restoreRuntimeJob,
  statusAfterSuccessfulDelivery,
} from "../src/runtime-bucket/jobs.js";
import { publishRuntimeMemory, restoreRuntimeMemory } from "../src/runtime-bucket/memory.js";
import {
  promoteRuntimeProcess,
  restoreRuntimeProcess,
  stageRuntimeProcess,
} from "../src/runtime-bucket/process-generation.js";
import { enqueueRuntimeJob, selectRuntimeJob, updateRuntimeQueueAfterDelivery } from "../src/runtime-bucket/queue.js";
import type { RuntimeObjectInfo, RuntimeObjectStore } from "../src/runtime-bucket/types.js";
import type { Candidate, SourceCaptureManifest, SourceConfig } from "../src/types.js";

class IntegrationStore implements RuntimeObjectStore {
  readonly objects = new Map<string, Uint8Array>();

  async upload(objectName: string, localFile: string): Promise<void> {
    this.objects.set(objectName, await readFile(localFile));
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
    return [...this.objects].filter(([objectName]) => objectName.startsWith(prefix))
      .map(([objectName, body]) => ({ objectName, size: body.byteLength }));
  }

  async delete(objectNames: readonly string[]): Promise<void> {
    for (const objectName of objectNames) this.objects.delete(objectName);
  }
}

const temporaryRoots: string[] = [];

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `jojo-runtime-${label}-`));
  temporaryRoots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function writeRawRound(
  output: string,
  source: SourceConfig,
  round: number,
): Promise<{ runManifest: string; articleId: string }> {
  const runId = `runtime-round-${round}`;
  const articleId = `thepaper:runtime-${round}`;
  const sourceRoot = path.join(output, "raw", source.id, "runs", "2026", "09", "01", runId);
  const sourceManifestObject = path.relative(output, path.join(sourceRoot, "manifest.json")).split(path.sep).join("/");
  const body = `<p>${`第${round}轮运行保存了一篇完整报道，并验证抓取记忆、处理记忆和发布索引可以连续衔接。`.repeat(8)}</p>`;
  const candidate: Candidate = {
    articleId,
    sourceId: source.id,
    sourceName: source.name,
    language: source.language,
    sourceUrl: `https://www.thepaper.cn/newsDetail_forward_runtime${round}`,
    canonicalUrl: `https://www.thepaper.cn/newsDetail_forward_runtime${round}`,
    title: `Runtime 连续验证第 ${round} 轮`,
    discoveryBody: body,
    captureStatus: "captured",
    contentStatus: "full",
    publishedAt: `2026-09-01T0${round}:00:00.000Z`,
    authors: [],
    publisherCategories: ["测试"],
    publisherSections: [{ id: "current-affairs", name: "时事" }],
    assets: [],
  };
  const manifest: SourceCaptureManifest = {
    formatVersion: "jojo-times-raw-source-run/2",
    runId,
    sourceId: source.id,
    sourceName: source.name,
    publicationTimeZone: source.publicationTimeZone,
    startedAt: `2026-09-01T0${round}:00:00.000Z`,
    completedAt: `2026-09-01T0${round}:01:00.000Z`,
    discovery: source.discovery,
    candidateCount: 1,
    fullCount: 1,
    summaryCount: 0,
    metadataCount: 0,
    networkExchangeCount: 0,
    objects: [],
    captureStatus: "pages-complete",
    healthStatus: "healthy",
    complete: true,
  };
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  await writeFile(path.join(sourceRoot, "candidates.jsonl.gz"), gzipSync(`${JSON.stringify(candidate)}\n`));
  const stateFile = path.join(output, "raw", source.id, "state.json.gz");
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, gzipSync(JSON.stringify({
    formatVersion: "jojo-page-capture-state/1",
    updatedAt: `2026-09-01T0${round}:01:00.000Z`,
    articles: Object.fromEntries(Array.from({ length: round }, (_, index) => [
      `thepaper:runtime-${index + 1}`,
      { fingerprint: `round-${index + 1}`, lastAttempt: `2026-09-01T0${index + 1}:01:00.000Z`, error: null },
    ])),
  })));
  const runManifest = path.join(output, "raw", "runs", "2026", "09", "01", `${runId}.json`);
  await mkdir(path.dirname(runManifest), { recursive: true });
  await writeFile(runManifest, `${JSON.stringify({
    formatVersion: "jojo-times-raw-run/1",
    runId,
    complete: true,
    sources: [{ sourceId: source.id, status: "ok", output: { manifest: sourceManifestObject } }],
  })}\n`);
  return { runManifest, articleId };
}

describe("Runtime Capture → Process → B2 continuity", () => {
  it("runs three isolated rounds without Dataset state or repeated Raw fetches", async () => {
    const source = JSON.parse(await readFile(path.resolve("src/sources/thepaper/source.json"), "utf8")) as SourceConfig;
    const store = new IntegrationStore();
    const work = await tempRoot("work");
    let previousTimelineIndex: TimesTimelineIndex | undefined;
    let previousTimelineDay: TimesTimelineDay | undefined;
    let previousSourceIndex: TimesSourceIndex | undefined;
    let previousCatalog: JojoCatalog | undefined;
    let lastStatus: ReturnType<typeof statusAfterSuccessfulDelivery> | undefined;

    for (let round = 1; round <= 3; round += 1) {
      const captureOutput = await tempRoot(`capture-${round}`);
      if (round > 1) {
        const restoredCapture = await restoreRuntimeMemory({
          store, output: captureOutput, workDirectory: work, kind: "capture",
        });
        expect(restoredCapture.restored).toBe(true);
      }
      const { runManifest, articleId } = await writeRawRound(captureOutput, source, round);
      const jobId = `round-${round}`;
      const ready = await publishRuntimeJob({
        store,
        output: captureOutput,
        runManifest,
        jobId,
        workDirectory: work,
        now: new Date(`2026-09-01T0${round}:02:00.000Z`),
      });
      await enqueueRuntimeJob({ store, status: ready, workDirectory: work });
      await publishRuntimeMemory({
        store,
        output: captureOutput,
        workDirectory: work,
        kind: "capture",
        basedOnJobId: jobId,
        now: new Date(`2026-09-01T0${round}:02:00.000Z`),
      });

      const selected = await selectRuntimeJob({ store, workDirectory: work, preferredJobId: jobId });
      expect(selected?.jobId).toBe(jobId);
      const processOutput = await tempRoot(`process-${round}`);
      const restoredProcess = await restoreRuntimeProcess({
        store, output: processOutput, workDirectory: work, status: selected!,
      });
      expect(restoredProcess).toMatchObject({ restored: round > 1, replay: false });
      const restoredJob = await restoreRuntimeJob({ store, output: processOutput, workDirectory: work, jobId });
      const pendingFile = path.join(work, `${jobId}.pending.json`);
      await writeFile(pendingFile, `${JSON.stringify(restoredJob.articles.pending)}\n`);
      const processed = await runProcess(new Map([
        ["config", path.resolve("sources.v2.json")],
        ["output", processOutput],
        ["run-manifest", path.join(processOutput, ...restoredJob.runManifest.split("/"))],
        ["raw-revision", `runtime/${jobId}/${restoredJob.raw.sha256}`],
        ["article-ids-file", pendingFile],
        ["translate", "false"],
      ]));
      expect(processed.sources[0]?.articles.map((article) => article.articleId)).toEqual([articleId]);
      expect(processed.sources[0]?.processingFailures).toEqual([]);
      const processResultFile = path.join(work, `${jobId}.process-result.json`);
      await writeFile(processResultFile, `${JSON.stringify(processed)}\n`);
      const staged = await stageRuntimeProcess({
        store,
        output: processOutput,
        workDirectory: work,
        status: restoredJob,
        processResultFile,
        now: new Date(`2026-09-01T0${round}:04:00.000Z`),
        retentionDays: 8,
      });
      await publishRuntimeJobStatus({ store, status: staged, workDirectory: work });

      const deliveryRoot = await tempRoot(`delivery-${round}`);
      await buildNewsDelivery({
        workspaceRoot: processOutput,
        deliveryRoot,
        generatedAt: `2026-09-01T0${round}:05:00.000Z`,
        sources: [source],
        process: processed,
        ...(previousTimelineIndex ? { previousTimelineIndex } : {}),
        ...(previousTimelineDay ? { previousTimelineDays: new Map([["2026-09-01", previousTimelineDay]]) } : {}),
        ...(previousSourceIndex ? { previousSourceIndexes: new Map([[source.id, previousSourceIndex]]) } : {}),
        ...(previousCatalog ? { previousCatalog } : {}),
      });
      previousTimelineIndex = await readJoxJson<TimesTimelineIndex>(
        new Uint8Array(await readFile(path.join(deliveryRoot, "content", "timeline", "index.jox"))),
        "content/timeline/index.jox",
      );
      previousTimelineDay = await readJoxJson<TimesTimelineDay>(
        new Uint8Array(await readFile(path.join(deliveryRoot, "content", "timeline", "dates", "2026", "09", "2026-09-01.jox"))),
        "content/timeline/dates/2026/09/2026-09-01.jox",
      );
      previousSourceIndex = await readJoxJson<TimesSourceIndex>(
        new Uint8Array(await readFile(path.join(deliveryRoot, "content", "newspapers", source.id, "index.jox"))),
        `content/newspapers/${source.id}/index.jox`,
      );
      previousCatalog = await readJoxJson<JojoCatalog>(
        new Uint8Array(await readFile(path.join(deliveryRoot, "catalog.jox"))),
        "catalog.jox",
      );

      await promoteRuntimeProcess({
        store, status: staged, workDirectory: work, now: new Date(`2026-09-01T0${round}:06:00.000Z`),
      });
      const done = statusAfterSuccessfulDelivery(staged, processed, new Date(`2026-09-01T0${round}:06:00.000Z`));
      expect(done.state).toBe("done");
      expect(done.stagedProcess).toBeUndefined();
      await publishRuntimeJobStatus({ store, status: done, workDirectory: work });
      await updateRuntimeQueueAfterDelivery({ store, status: done, workDirectory: work });
      lastStatus = done;
    }

    expect(previousTimelineDay?.articles.map((article) => article.id).sort()).toEqual([
      "thepaper:runtime-1",
      "thepaper:runtime-2",
      "thepaper:runtime-3",
    ]);
    expect(await selectRuntimeJob({ store, workDirectory: work })).toBeNull();

    const restored = await tempRoot("final-process-memory");
    const memory = await restoreRuntimeProcess({ store, output: restored, workDirectory: work, status: lastStatus! });
    expect(memory).toMatchObject({ restored: true, replay: false, basedOnJobId: "round-3" });
    const index = JSON.parse(gunzipSync(await readFile(path.join(
      restored, "canonical", source.id, "dates", "2026", "09", "2026-09-01.json.gz",
    ))).toString("utf8")) as { articles: Array<{ articleId: string }> };
    expect(index.articles.map((article) => article.articleId).sort()).toEqual([
      "thepaper:runtime-1",
      "thepaper:runtime-2",
      "thepaper:runtime-3",
    ]);
  }, 30_000);
});
