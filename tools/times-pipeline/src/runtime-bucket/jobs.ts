import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createArchive, describeFiles, extractVerifiedArchive, fileSha256 } from "./archive.js";
import {
  jobObjectNames,
  parseRuntimeJobStatus,
  type RuntimeJobArticle,
  type RuntimeJobFailure,
  type RuntimeJobStatus,
  type RuntimeObjectStore,
  safeJobId,
  safeRuntimePath,
  safeSourceId,
} from "./types.js";

interface RawRunManifest {
  runId?: unknown;
  completedAt?: unknown;
  sources?: unknown;
}

interface ProcessSourceResult {
  sourceId?: unknown;
  articles?: unknown;
  unchangedArticles?: unknown;
  skippedArticles?: unknown;
  processingFailures?: unknown;
}

interface ProcessResult {
  sources?: unknown;
}

function rowsFromJsonLines(compressed: Uint8Array): unknown[] {
  return gunzipSync(compressed).toString("utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as unknown);
}

async function jobArticles(output: string, runManifestFile: string): Promise<RuntimeJobArticle[]> {
  const run = JSON.parse(await readFile(runManifestFile, "utf8")) as RawRunManifest;
  if (!Array.isArray(run.sources)) throw new Error("Raw run manifest sources are invalid");
  const articles = new Map<string, RuntimeJobArticle>();
  for (const sourceValue of run.sources) {
    if (!sourceValue || typeof sourceValue !== "object" || Array.isArray(sourceValue)) continue;
    const source = sourceValue as { sourceId?: unknown; status?: unknown; output?: { manifest?: unknown } };
    if (source.status !== "ok" || typeof source.output?.manifest !== "string") continue;
    const sourceId = safeSourceId(source.sourceId);
    const manifestObject = safeRuntimePath(source.output.manifest, "Raw source manifest");
    const candidateFile = path.join(output, ...path.posix.join(path.posix.dirname(manifestObject), "candidates.jsonl.gz").split("/"));
    for (const candidateValue of rowsFromJsonLines(await readFile(candidateFile))) {
      if (!candidateValue || typeof candidateValue !== "object" || Array.isArray(candidateValue)) continue;
      const articleId = (candidateValue as { articleId?: unknown }).articleId;
      if (typeof articleId !== "string" || !articleId.trim()) throw new Error(`Invalid article id in ${candidateFile}`);
      articles.set(`${sourceId}\0${articleId}`, { sourceId, articleId });
    }
  }
  return [...articles.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId)
    || left.articleId.localeCompare(right.articleId));
}

export async function publishRuntimeJob(options: {
  store: RuntimeObjectStore;
  output: string;
  runManifest: string;
  jobId: string;
  workDirectory: string;
  now?: Date;
}): Promise<RuntimeJobStatus> {
  const output = path.resolve(options.output);
  const runManifestFile = path.resolve(options.runManifest);
  const run = JSON.parse(await readFile(runManifestFile, "utf8")) as RawRunManifest;
  if (typeof run.runId !== "string" || !run.runId.trim()) throw new Error("Raw run manifest has no run id");
  const objects = jobObjectNames(options.jobId);
  const files = await describeFiles(output, (relativePath) => relativePath.startsWith("raw/"));
  if (!files.some((entry) => path.resolve(output, ...entry.path.split("/")) === runManifestFile)) {
    throw new Error("Raw run manifest is outside the Runtime job payload");
  }
  const archiveFile = path.resolve(options.workDirectory, `${options.jobId}.raw.tar`);
  const archive = await createArchive(output, files, archiveFile, false);
  const createdAt = (options.now ?? new Date()).toISOString();
  const articles = await jobArticles(output, runManifestFile);
  const status: RuntimeJobStatus = {
    formatVersion: "jojo-times-job/1",
    jobId: options.jobId,
    runId: run.runId,
    runManifest: path.relative(output, runManifestFile).split(path.sep).join("/"),
    createdAt,
    updatedAt: createdAt,
    state: "ready",
    attempts: 0,
    raw: {
      objectName: objects.raw,
      size: archive.size,
      sha256: archive.sha256,
      files,
    },
    articles: {
      total: articles.length,
      pending: articles,
      completed: 0,
      excluded: 0,
    },
    failures: [],
  };
  const statusFile = path.resolve(options.workDirectory, `${options.jobId}.status.json`);
  await mkdir(path.dirname(statusFile), { recursive: true });
  await writeFile(statusFile, `${JSON.stringify(status, null, 2)}\n`);

  const [existingStatus, existingRaw] = await Promise.all([
    readRuntimeJob(options.store, options.jobId),
    options.store.info(objects.raw),
  ]);
  if (existingStatus) {
    const exactInitialJob = existingStatus.state === "ready"
      && existingStatus.attempts === 0
      && existingStatus.stagedProcess === undefined
      && existingStatus.raw.size === status.raw.size
      && existingStatus.raw.sha256 === status.raw.sha256
      && JSON.stringify(existingStatus.raw.files) === JSON.stringify(status.raw.files)
      && JSON.stringify(existingStatus.articles.pending) === JSON.stringify(status.articles.pending);
    if (!exactInitialJob || !existingRaw || existingRaw.size !== status.raw.size) {
      throw new Error(`Runtime job already exists with different or advanced state: ${options.jobId}`);
    }
    return existingStatus;
  }
  if (existingRaw) {
    throw new Error(`Runtime job has an orphan Raw object and cannot be overwritten: ${options.jobId}`);
  }

  // The status object is the completion marker. It must never be visible before Raw is durable.
  await options.store.upload(objects.raw, archive.file);
  await options.store.upload(objects.status, statusFile);
  return status;
}

export async function readRuntimeJob(
  store: RuntimeObjectStore,
  jobId: string,
): Promise<RuntimeJobStatus | null> {
  const body = await store.readText(jobObjectNames(jobId).status);
  if (body === null) return null;
  return parseRuntimeJobStatus(JSON.parse(body) as unknown);
}

export async function restoreRuntimeJob(options: {
  store: RuntimeObjectStore;
  output: string;
  jobId: string;
  workDirectory: string;
}): Promise<RuntimeJobStatus> {
  const status = await readRuntimeJob(options.store, options.jobId);
  if (!status) throw new Error(`Runtime job does not exist: ${options.jobId}`);
  if (status.state === "done") throw new Error(`Runtime job is already done: ${options.jobId}`);
  const archive = path.resolve(options.workDirectory, `${options.jobId}.raw.tar`);
  if (!await options.store.download(status.raw.objectName, archive, { maxBytes: status.raw.size })) {
    throw new Error(`Runtime job Raw is missing: ${status.raw.objectName}`);
  }
  const metadata = await stat(archive);
  if (metadata.size !== status.raw.size) {
    throw new Error(`Runtime job Raw size mismatch: expected ${status.raw.size}, got ${metadata.size}`);
  }
  const digest = await fileSha256(archive);
  if (digest !== status.raw.sha256) throw new Error("Runtime job Raw SHA-256 mismatch");
  await extractVerifiedArchive(archive, options.output, status.raw.files);
  return status;
}

export async function restoreRuntimeJobBatch(options: {
  store: RuntimeObjectStore;
  output: string;
  jobIds: readonly string[];
  workDirectory: string;
}): Promise<{
  anchorJobId: string;
  jobIds: string[];
  statuses: RuntimeJobStatus[];
  localRunManifest: string;
  pendingArticlesFile: string;
  rawRevision: string;
}> {
  const jobIds = options.jobIds.map((jobId) => safeJobId(jobId));
  if (jobIds.length === 0 || jobIds.length > 20 || new Set(jobIds).size !== jobIds.length) {
    throw new Error("Runtime batch must contain 1 to 20 unique jobs");
  }
  const statuses: RuntimeJobStatus[] = [];
  for (const jobId of jobIds) {
    statuses.push(await restoreRuntimeJob({ ...options, jobId }));
  }

  const combinedSources: unknown[] = [];
  // Newest manifests win the global article-id de-duplication in Process.
  for (const status of statuses.toReversed()) {
    const manifestFile = path.join(path.resolve(options.output), ...status.runManifest.split("/"));
    const run = JSON.parse(await readFile(manifestFile, "utf8")) as RawRunManifest;
    if (!Array.isArray(run.sources)) throw new Error(`Runtime job ${status.jobId} has an invalid Raw run manifest`);
    combinedSources.push(...run.sources);
  }

  const anchorJobId = statuses[0]!.jobId;
  const localRunManifest = path.resolve(options.workDirectory, `${anchorJobId}.batch-run.json`);
  await mkdir(path.dirname(localRunManifest), { recursive: true });
  await writeFile(localRunManifest, `${JSON.stringify({
    formatVersion: "jojo-times-raw-run/1",
    runId: `batch-${anchorJobId}`,
    complete: true,
    sources: combinedSources,
  }, null, 2)}\n`);

  const pending = new Map<string, RuntimeJobArticle>();
  for (const status of statuses) {
    for (const article of status.articles.pending) {
      pending.set(`${article.sourceId}\0${article.articleId}`, article);
    }
  }
  const pendingArticlesFile = path.resolve(options.workDirectory, `${anchorJobId}.batch-pending-articles.json`);
  await writeFile(pendingArticlesFile, `${JSON.stringify([...pending.values()], null, 2)}\n`);
  const rawRevision = `runtime-batch/${createHash("sha256")
    .update(statuses.map((status) => `${status.jobId}:${status.raw.sha256}`).join("\n"))
    .digest("hex")}`;
  return {
    anchorJobId,
    jobIds,
    statuses,
    localRunManifest,
    pendingArticlesFile,
    rawRevision,
  };
}

function resultArticleId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const articleId = (value as { articleId?: unknown }).articleId;
  return typeof articleId === "string" && articleId.trim() ? articleId : undefined;
}

function processOutcome(resultValue: unknown): {
  completed: Set<string>;
  excluded: Set<string>;
  retryable: Map<string, RuntimeJobFailure>;
} {
  const result = resultValue as ProcessResult;
  if (!result || !Array.isArray(result.sources)) throw new Error("Process result sources are invalid");
  const completed = new Set<string>();
  const excluded = new Set<string>();
  const retryable = new Map<string, RuntimeJobFailure>();
  for (const sourceValue of result.sources) {
    if (!sourceValue || typeof sourceValue !== "object" || Array.isArray(sourceValue)) continue;
    const source = sourceValue as ProcessSourceResult;
    const sourceId = safeSourceId(source.sourceId);
    for (const field of [source.articles, source.unchangedArticles]) {
      if (!Array.isArray(field)) continue;
      for (const article of field) {
        const articleId = resultArticleId(article);
        if (articleId) completed.add(`${sourceId}\0${articleId}`);
      }
    }
    if (Array.isArray(source.skippedArticles)) {
      for (const skippedValue of source.skippedArticles) {
        const articleId = resultArticleId(skippedValue);
        if (!articleId) continue;
        excluded.add(`${sourceId}\0${articleId}`);
      }
    }
    if (Array.isArray(source.processingFailures)) {
      for (const failureValue of source.processingFailures) {
        const articleId = resultArticleId(failureValue);
        if (!articleId) continue;
        const reasonValue = (failureValue as { error?: unknown }).error;
        retryable.set(`${sourceId}\0${articleId}`, {
          sourceId,
          articleId,
          reason: typeof reasonValue === "string" && reasonValue.trim() ? reasonValue : "process-error",
        });
      }
    }
  }
  return { completed, excluded, retryable };
}

export function statusAfterSuccessfulDelivery(
  statusValue: RuntimeJobStatus,
  processResult: unknown,
  now = new Date(),
): RuntimeJobStatus {
  const status = parseRuntimeJobStatus(statusValue);
  const outcome = processOutcome(processResult);
  const pending: RuntimeJobArticle[] = [];
  const failures: RuntimeJobFailure[] = [];
  let completed = status.articles.completed;
  let excluded = status.articles.excluded;
  for (const article of status.articles.pending) {
    const key = `${article.sourceId}\0${article.articleId}`;
    const failure = outcome.retryable.get(key);
    if (failure) {
      pending.push(article);
      failures.push(failure);
    } else if (outcome.excluded.has(key)) {
      excluded += 1;
    } else if (outcome.completed.has(key)) {
      completed += 1;
    } else {
      pending.push(article);
      failures.push({ ...article, reason: "not-reported-by-process" });
    }
  }
  const next: RuntimeJobStatus = {
    ...status,
    updatedAt: now.toISOString(),
    state: pending.length ? "partial" : "done",
    attempts: status.attempts + 1,
    articles: { total: status.articles.total, pending, completed, excluded },
    failures,
  };
  delete next.stagedProcess;
  return parseRuntimeJobStatus(next);
}

export function statusAfterRuntimeFailure(
  statusValue: RuntimeJobStatus,
  reason: string,
  now = new Date(),
): RuntimeJobStatus {
  const status = parseRuntimeJobStatus(statusValue);
  if (status.state === "done") return status;
  const normalizedReason = reason.trim().slice(0, 2_000) || "runtime-step-failed";
  return parseRuntimeJobStatus({
    ...status,
    // Once Process output has been staged, later jobs must not advance the
    // committed pointer past it. Keep this oldest transaction at the FIFO head
    // until its exact B2 replay commits. Pre-stage failures may back off.
    state: status.stagedProcess ? "ready" : "partial",
    attempts: status.attempts + 1,
    updatedAt: now.toISOString(),
    failures: status.articles.pending.map((article) => ({ ...article, reason: normalizedReason })),
  });
}

export async function publishRuntimeJobStatus(options: {
  store: RuntimeObjectStore;
  status: RuntimeJobStatus;
  workDirectory: string;
}): Promise<void> {
  const status = parseRuntimeJobStatus(options.status);
  const statusFile = path.resolve(options.workDirectory, `${status.jobId}.status-update.json`);
  await mkdir(path.dirname(statusFile), { recursive: true });
  await writeFile(statusFile, `${JSON.stringify(status, null, 2)}\n`);
  await options.store.upload(jobObjectNames(status.jobId).status, statusFile);
}

export async function removeLocalRuntimeJobWork(workDirectory: string, jobId: string): Promise<void> {
  await Promise.all([
    rm(path.resolve(workDirectory, `${jobId}.raw.tar`), { force: true }),
    rm(path.resolve(workDirectory, `${jobId}.status.json`), { force: true }),
    rm(path.resolve(workDirectory, `${jobId}.status-update.json`), { force: true }),
  ]);
}
