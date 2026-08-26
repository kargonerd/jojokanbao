import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { parseArgs, requiredArg } from "./args.js";
import { extractRenderedBody } from "./archive/body.js";
import { proxyCandidates, selectProxy } from "./archive/proxy.js";
import {
  BROWSERTRIX_IMAGE,
  runBrowsertrixAttempt,
  type BrowsertrixAttempt,
  type BrowsertrixCapture,
} from "./archive/browsertrix.js";
import {
  articleFingerprint,
  selectArticlesForCapture,
  type ArchiveArticle,
  type ArchiveState,
} from "./archive/select.js";
import { loadSources } from "./config.js";
import type { Candidate, SourceCaptureManifest, SourceConfig, SourcePagePolicy } from "./types.js";

interface RawRunManifest {
  runId: string;
  sources: Array<{
    sourceId: string;
    status: "ok" | "empty" | "error";
    output?: { manifest?: string };
    error?: string;
  }>;
  browserArchive?: unknown;
}

interface ArticleBundle extends ArchiveArticle {
  source: SourceConfig;
  manifestPath: string;
  pagePolicy?: SourcePagePolicy;
}

function readJson<T>(body: string): T {
  return JSON.parse(body) as T;
}

async function jsonFile<T>(file: string): Promise<T> {
  return readJson<T>(await readFile(file, "utf8"));
}

async function candidatesFile(file: string): Promise<Candidate[]> {
  try {
    return gunzipSync(await readFile(file)).toString("utf8")
      .split(/\r?\n/u).filter(Boolean).map((line) => readJson<Candidate>(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function loadArchiveState(file: string): Promise<ArchiveState> {
  try {
    const value = readJson<ArchiveState>(gunzipSync(await readFile(file)).toString("utf8"));
    if (value.formatVersion === "jojo-web-archive-state/1" && value.articles && typeof value.articles === "object") return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") process.stderr.write("Ignoring an invalid browser archive state\n");
  }
  return { formatVersion: "jojo-web-archive-state/1", articles: {} };
}

async function loadArticles(
  workspace: string,
  run: RawRunManifest,
  sources: Map<string, SourceConfig>,
): Promise<ArticleBundle[]> {
  const articles: ArticleBundle[] = [];
  for (const result of run.sources) {
    if (result.status !== "ok" || !result.output?.manifest) continue;
    const source = sources.get(result.sourceId);
    if (!source || source.archive.mode !== "browser") continue;
    const manifestPath = path.join(workspace, ...result.output.manifest.split("/"));
    const manifest = await jsonFile<SourceCaptureManifest>(manifestPath);
    for (const candidate of await candidatesFile(path.join(path.dirname(manifestPath), "candidates.jsonl.gz"))) {
      articles.push({
        articleId: candidate.articleId,
        sourceId: source.id,
        title: candidate.title,
        canonicalUrl: candidate.canonicalUrl,
        captureUrl: manifest.pagePolicy?.captureUrl === "source" ? candidate.sourceUrl : candidate.canonicalUrl,
        publishedAt: candidate.publishedAt,
        source,
        manifestPath,
        ...(manifest.pagePolicy ? { pagePolicy: manifest.pagePolicy } : {}),
      });
    }
  }
  return articles;
}

function captureSucceeded(capture: BrowsertrixCapture | undefined): boolean {
  return Boolean(capture && !capture.error && capture.status !== undefined && capture.status >= 200 && capture.status < 400);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function applyCaptureResults(
  workspace: string,
  run: RawRunManifest,
  captures: Map<string, BrowsertrixCapture>,
): Promise<number> {
  let fullBodies = 0;
  for (const result of run.sources) {
    if (!result.output?.manifest) continue;
    const manifestPath = path.join(workspace, ...result.output.manifest.split("/"));
    const candidatePath = path.join(path.dirname(manifestPath), "candidates.jsonl.gz");
    const manifest = await jsonFile<SourceCaptureManifest & { browserArchive?: unknown }>(manifestPath);
    const rows = await candidatesFile(candidatePath);
    let attempts = 0;
    let succeeded = 0;
    let failed = 0;
    let extracted = 0;
    const archiveObjects = new Set<string>();
    for (const row of rows) {
      const capture = captures.get(row.articleId);
      if (!capture) continue;
      attempts += 1;
      archiveObjects.add(capture.waczObject);
      row.browserArchiveObject = capture.waczObject;
      if (capture.capturedAt) row.browserCapturedAt = capture.capturedAt;
      if (capture.status !== undefined) row.browserHttpStatus = capture.status;
      if (!captureSucceeded(capture)) {
        failed += 1;
        continue;
      }
      succeeded += 1;
      const body = capture.renderedHtml ? extractRenderedBody(capture.renderedHtml, manifest.pagePolicy) : undefined;
      if (!body) continue;
      row.browserBody = body;
      row.contentStatus = "full";
      extracted += 1;
      fullBodies += 1;
    }
    if (!attempts) continue;
    const candidateBytes = gzipSync(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, { level: 9 });
    await writeFile(candidatePath, candidateBytes);
    manifest.fullCount = rows.filter((row) => row.contentStatus === "full").length;
    manifest.summaryCount = rows.filter((row) => row.contentStatus === "summary").length;
    manifest.metadataCount = rows.filter((row) => row.contentStatus === "metadata").length;
    manifest.archiveStatus = "wacz-complete";
    manifest.browserArchive = {
      objects: [...archiveObjects],
      attempts,
      succeeded,
      failed,
      extractedFullBodies: extracted,
    };
    for (const descriptor of manifest.objects) {
      if (descriptor.path !== "candidates.jsonl.gz") continue;
      descriptor.size = candidateBytes.byteLength;
      descriptor.sha256 = sha256(candidateBytes);
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return fullBodies;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workspace = path.resolve(requiredArg(args, "output"));
  const runPath = path.resolve(requiredArg(args, "run-manifest"));
  const configPath = path.resolve(requiredArg(args, "config"));
  const maximumPages = Number(args.get("max-pages") ?? "50");
  const workers = Number(args.get("workers") ?? "8");
  const timeoutSeconds = Number(args.get("timeout") ?? "25");
  const refreshHours = Number(args.get("refresh-hours") ?? "24");
  const retryHours = Number(args.get("retry-hours") ?? "2");
  const rotationAttempts = Number(args.get("proxy-rotation-attempts") ?? "0");
  if (![maximumPages, workers, timeoutSeconds, refreshHours, retryHours, rotationAttempts].every(Number.isFinite)
    || maximumPages < 0 || workers < 1 || timeoutSeconds <= 0 || refreshHours <= 0 || retryHours <= 0 || rotationAttempts < 0) {
    throw new Error("Archive limits, workers and timeouts must be valid");
  }
  const run = await jsonFile<RawRunManifest>(runPath);
  const sources = new Map((await loadSources(configPath)).map((source) => [source.id, source]));
  const requested = new Set((args.get("sources") ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  const articles = (await loadArticles(workspace, run, sources))
    .filter((article) => requested.size === 0 || requested.has(article.sourceId));
  const archiveRoot = path.join(workspace, "raw", "web-archives", "times");
  const statePath = path.join(archiveRoot, "state.json.gz");
  const state = await loadArchiveState(statePath);
  const generatedAt = new Date();
  const selected = selectArticlesForCapture(articles, state, {
    now: generatedAt,
    retentionDays: 7,
    maximumPages,
    refreshHours,
    retryHours,
  }) as ArticleBundle[];
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const driverPath = path.join(packageRoot, "browsertrix", "driver.mjs");
  const attempts: BrowsertrixAttempt[] = [];
  const attemptErrors: Array<{ round: number; error: string }> = [];
  const best = new Map<string, BrowsertrixCapture>();
  const proxyServer = args.get("proxy-server");
  const controlUrl = args.get("proxy-control-url");
  const proxyGroup = args.get("proxy-group") ?? "JOJO-TIMES-ROUTE";
  const automaticName = args.get("proxy-automatic-name") ?? "JOJO-TIMES-AUTO";
  let proxyRotationRounds = 0;

  const capture = async (values: ArticleBundle[], round: number): Promise<boolean> => {
    if (!values.length) return true;
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), `jojo-browsertrix-${round}-`));
    try {
      const attempt = await runBrowsertrixAttempt({
        image: args.get("browsertrix-image") ?? BROWSERTRIX_IMAGE,
        workspace,
        temporaryRoot,
        rawArchiveRoot: archiveRoot,
        runId: run.runId,
        round,
        articles: values,
        workers,
        timeoutSeconds,
        ...(proxyServer ? { proxyServer } : {}),
        ...(args.get("browser-extension-path") ? { extensionPath: path.resolve(args.get("browser-extension-path")!) } : {}),
        driverPath,
      });
      attempts.push(attempt);
      for (const result of attempt.captures) {
        const previous = best.get(result.articleId);
        if (captureSucceeded(result) || !captureSucceeded(previous)) best.set(result.articleId, result);
      }
      return true;
    } catch (error) {
      attemptErrors.push({
        round,
        error: error instanceof Error && error.message.startsWith("Browsertrix did not produce a WACZ")
          ? "BrowsertrixWaczMissing"
          : "BrowsertrixAttemptFailed",
      });
      return false;
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  };

  await capture(selected, 0);
  if (selected.length && proxyServer && controlUrl && rotationAttempts > 0) {
    try {
      const alternatives = await proxyCandidates(controlUrl, proxyGroup, automaticName, rotationAttempts);
      for (const alternative of alternatives) {
        const retry = selected.filter((article) => !captureSucceeded(best.get(article.articleId)));
        if (!retry.length) break;
        await selectProxy(controlUrl, proxyGroup, alternative);
        await new Promise((resolve) => setTimeout(resolve, 250));
        const completed = await capture(retry, attempts.length);
        proxyRotationRounds += 1;
        if (!completed) break;
      }
    } finally {
      await selectProxy(controlUrl, proxyGroup, automaticName);
    }
  }

  const extractedFullBodies = await applyCaptureResults(workspace, run, best);
  await mkdir(archiveRoot, { recursive: true });
  for (const article of selected) {
    const result = best.get(article.articleId);
    state.articles[article.articleId] = {
      fingerprint: articleFingerprint(article),
      lastAttempt: generatedAt.toISOString(),
      ...(result?.capturedAt ? { capturedAt: result.capturedAt } : {}),
      ...(result?.status !== undefined ? { httpStatus: result.status } : {}),
      error: result?.error ?? null,
      ...(result?.waczObject ? { waczObject: result.waczObject } : {}),
    };
  }
  state.updatedAt = generatedAt.toISOString();
  await writeFile(statePath, gzipSync(`${JSON.stringify(state)}\n`, { level: 9 }));

  const captureBySource = new Map<string, { sourceId: string; attempts: number; routeAttempts: number; succeeded: number; failed: number }>();
  for (const article of selected) {
    const row = captureBySource.get(article.sourceId) ?? { sourceId: article.sourceId, attempts: 0, routeAttempts: 0, succeeded: 0, failed: 0 };
    row.attempts += 1;
    row.routeAttempts += attempts.reduce((count, attempt) => count + Number(attempt.captures.some((capture) => capture.articleId === article.articleId)), 0);
    row[captureSucceeded(best.get(article.articleId)) ? "succeeded" : "failed"] += 1;
    captureBySource.set(article.sourceId, row);
  }
  const failedCases = selected.flatMap((article) => {
    const result = best.get(article.articleId);
    return captureSucceeded(result) ? [] : [{
      articleId: article.articleId,
      sourceId: article.sourceId,
      title: article.title,
      url: article.captureUrl,
      httpStatus: result?.status,
      error: result?.error ?? "BrowsertrixMissingPage",
      routeAttempts: attempts.reduce((count, attempt) => count + Number(attempt.captures.some((capture) => capture.articleId === article.articleId)), 0),
    }];
  });
  const archiveDirectory = path.join(archiveRoot, ...generatedAt.toISOString().slice(0, 10).split("-"), run.runId);
  await mkdir(archiveDirectory, { recursive: true });
  const report = {
    formatVersion: "jojo-browsertrix-archive-run/1",
    runId: run.runId,
    generatedAt: generatedAt.toISOString(),
    discovered: articles.length,
    selected: selected.length,
    waczObjects: attempts.map((attempt) => attempt.waczObject),
    waczBytes: attempts.reduce((sum, attempt) => sum + attempt.waczBytes, 0),
    articleAttempts: selected.length,
    articleFailures: failedCases.length,
    extractedFullBodies,
    attemptErrors,
    captureBySource: [...captureBySource.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    failedCases,
    browser: {
      engine: "browsertrix",
      image: args.get("browsertrix-image") ?? BROWSERTRIX_IMAGE,
      extensionEnabled: Boolean(args.get("browser-extension-path")),
      extensionRevision: args.get("browser-extension-revision") ?? null,
      proxyConfigured: Boolean(proxyServer),
      proxyRotationRounds,
      workers,
      maximumPages,
    },
  };
  await writeFile(path.join(archiveDirectory, "run.json"), `${JSON.stringify(report, null, 2)}\n`);
  run.browserArchive = report;
  await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
