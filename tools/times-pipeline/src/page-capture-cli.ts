import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, requiredArg } from "./args.js";
import { loadSources } from "./config.js";
import { bodyQuality, selectArticleBody, type ArticleBodyAssessmentReport } from "./content/body.js";
import { captureArticleAssets } from "./capture/assets.js";
import { unavailablePageReason } from "./capture/availability.js";
import { BrowserSourceSession } from "./capture/browser.js";
import { allowsInRunCaptureRetry, captureWithBrowserFallback } from "./capture/fallback.js";
import { downloadDirectAsset, fetchDirectPage, type CapturedHtmlPage } from "./capture/http.js";
import { discoverArticleImages } from "./capture/page-images.js";
import {
  articleFingerprint,
  pendingArticles,
  selectRunArticles,
  type PageArticle,
  type PageCaptureState,
} from "./capture/pending.js";
import { proxyCandidates, selectProxy } from "./capture/proxy.js";
import { writeRawPage } from "./capture/raw-page.js";
import {
  mapSourceBatches,
  proxyTailSourceIds,
  rotatingSourceProbes,
  untriedProxyArticles,
} from "./capture/schedule.js";
import { sourceBodyExtractor, sourceImageExtractor, sourcePageCapture, sourceUnavailablePageReason } from "./sources/registry.js";
import type { Candidate, SourceCaptureManifest, SourceConfig, SourceFetchPolicy, UnavailablePageReason } from "./types.js";

interface RawRunManifest {
  runId: string;
  completedAt: string;
  sources: Array<{
    sourceId: string;
    status: "ok" | "empty" | "error";
    output?: { manifest?: string };
    error?: string;
  }>;
  pageCapture?: unknown;
}

interface ArticleBundle extends PageArticle {
  source: SourceConfig;
  candidate: Candidate;
  manifestPath: string;
  fetchPolicy?: SourceFetchPolicy;
}

interface CaptureOutcome {
  article: ArticleBundle;
  page: CapturedHtmlPage;
  fullBody: boolean;
  unavailableReason?: UnavailablePageReason;
  assetCount: number;
  rawPageObject: string;
  bodyAssessment: ArticleBodyAssessmentReport;
}

const CAPTURE_PIPELINE_REVISION = "semantic-html-media-v2";

function json<T>(body: string): T {
  return JSON.parse(body) as T;
}

async function readCandidates(target: string): Promise<Candidate[]> {
  return gunzipSync(await readFile(target)).toString("utf8").split(/\r?\n/u).filter(Boolean).map((line) => json<Candidate>(line));
}

async function loadState(target: string): Promise<PageCaptureState> {
  try {
    const state = json<PageCaptureState>(gunzipSync(await readFile(target)).toString("utf8"));
    if (state.formatVersion === "jojo-page-capture-state/1") return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") process.stderr.write(`Ignoring invalid capture state: ${target}\n`);
  }
  return { formatVersion: "jojo-page-capture-state/1", articles: {} };
}

async function filesBelow(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

async function descriptor(root: string, target: string): Promise<{ path: string; size: number; sha256: string }> {
  const body = await readFile(target);
  return {
    path: path.relative(root, target).replaceAll(path.sep, "/"),
    size: (await stat(target)).size,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

function successfulPage(page: CapturedHtmlPage, fullBody: boolean): boolean {
  return fullBody && Boolean(page.renderedHtml) && (!page.status || page.status < 500);
}

function retryableOutcome(outcome: CaptureOutcome | undefined): boolean {
  return allowsInRunCaptureRetry(outcome?.page) && !outcome?.fullBody && !outcome?.unavailableReason;
}

async function completeCapture(
  workspace: string,
  article: ArticleBundle,
  timeoutSeconds: number,
  page: CapturedHtmlPage,
  browser?: () => Promise<BrowserSourceSession>,
): Promise<CaptureOutcome> {
  const quality = bodyQuality(article.source);
  const sourceExtractor = sourceBodyExtractor(article.sourceId);
  const selection = selectArticleBody({
    ...(page.renderedHtml ? { capturedPage: { html: page.renderedHtml, pageUrl: page.finalUrl } } : {}),
    ...(article.candidate.discoveryBody
      ? { discoveryBody: { html: article.candidate.discoveryBody, pageUrl: article.canonicalUrl } }
      : {}),
  }, article.fetchPolicy, quality, sourceExtractor);
  const hasFullBody = Boolean(selection.body);
  const availabilityInput = {
    title: article.title,
    url: page.finalUrl,
    ...(page.renderedHtml ? { html: page.renderedHtml } : {}),
    hasFullBody,
  };
  const unavailableReason = unavailablePageReason(availabilityInput)
    ?? sourceUnavailablePageReason(article.source, availabilityInput);
  const fullBody = hasFullBody && unavailableReason === undefined;
  const images = fullBody && page.renderedHtml
    ? discoverArticleImages(page.renderedHtml, page.finalUrl, article.fetchPolicy, sourceImageExtractor(article.sourceId))
    : [];
  const session = images.length > 0 && page.method === "browser" && browser ? await browser() : undefined;
  const assets = await captureArticleAssets({
    workspace,
    sourceId: article.sourceId,
    pageUrl: page.finalUrl,
    images,
    download: (url, referer) => session
      ? session.downloadAsset(url, referer, timeoutSeconds)
      : downloadDirectAsset(url, referer, timeoutSeconds),
  });
  article.candidate.contentStatus = fullBody
    ? "full"
    : article.candidate.summary?.trim()
      ? "summary"
      : "metadata";
  article.candidate.assets = assets;
  article.candidate.capturedAt = page.capturedAt;
  article.candidate.captureMethod = page.method;
  article.candidate.bodyAssessment = selection.report;
  if (page.status !== undefined) article.candidate.captureHttpStatus = page.status;
  article.candidate.captureStatus = fullBody
    ? "captured"
    : unavailableReason === "HardPaywall"
      ? "hard-paywall"
      : unavailableReason === "UnsupportedMedia"
        ? "skipped"
        : "failed";
  const rawPageObject = await writeRawPage(
    workspace,
    article,
    page,
    fullBody ? undefined : unavailableReason ?? "FullTextNotExtracted",
    selection.report,
  );
  article.candidate.rawPageObject = rawPageObject;
  return {
    article,
    page,
    fullBody,
    ...(unavailableReason ? { unavailableReason } : {}),
    assetCount: assets.length,
    rawPageObject,
    bodyAssessment: selection.report,
  };
}

async function captureOne(
  workspace: string,
  article: ArticleBundle,
  timeoutSeconds: number,
  browser: () => Promise<BrowserSourceSession>,
  forceBrowser: boolean,
): Promise<CaptureOutcome> {
  const publisherCapture = sourcePageCapture(article.sourceId);
  const direct = !forceBrowser && publisherCapture
    ? () => publisherCapture(article.captureUrl, timeoutSeconds)
    : !forceBrowser && article.source.fetch.strategy === "direct-first"
      ? () => fetchDirectPage(article.captureUrl, timeoutSeconds)
      : undefined;
  const page = await captureWithBrowserFallback({
    ...(direct ? { direct } : {}),
    browser: async () => (await browser()).capture(article.captureUrl, timeoutSeconds),
    hasBody: (captured) => captured.renderedHtml
      ? Boolean(selectArticleBody(
          { capturedPage: { html: captured.renderedHtml, pageUrl: captured.finalUrl } },
          article.fetchPolicy,
          bodyQuality(article.source),
          sourceBodyExtractor(article.sourceId),
        ).body)
      : false,
  });
  return completeCapture(workspace, article, timeoutSeconds, page, browser);
}

async function loadArticles(workspace: string, run: RawRunManifest, sources: Map<string, SourceConfig>): Promise<ArticleBundle[]> {
  const articles: ArticleBundle[] = [];
  for (const result of run.sources) {
    if (result.status !== "ok" || !result.output?.manifest) continue;
    const source = sources.get(result.sourceId);
    if (!source) continue;
    const manifestPath = path.join(workspace, ...result.output.manifest.split("/"));
    const manifest = json<SourceCaptureManifest>(await readFile(manifestPath, "utf8"));
    for (const candidate of await readCandidates(path.join(path.dirname(manifestPath), "candidates.jsonl.gz"))) {
      articles.push({
        articleId: candidate.articleId,
        sourceId: source.id,
        title: candidate.title,
        canonicalUrl: candidate.canonicalUrl,
        captureUrl: manifest.fetchPolicy?.captureUrl === "source" ? candidate.sourceUrl : candidate.canonicalUrl,
        publishedAt: candidate.publishedAt,
        needsBody: candidate.contentStatus !== "full",
        captureRevision: [CAPTURE_PIPELINE_REVISION, manifest.fetchPolicy?.revision].filter(Boolean).join("+"),
        source,
        candidate,
        manifestPath,
        ...(manifest.fetchPolicy ? { fetchPolicy: manifest.fetchPolicy } : {}),
      });
    }
  }
  return articles;
}

async function persistSources(
  workspace: string,
  articles: ArticleBundle[],
  lookbackArticles: ArticleBundle[],
  states: Map<string, PageCaptureState>,
  processWindowHours: number,
  recoveryArticleIds: ReadonlySet<string>,
): Promise<void> {
  const byManifest = new Map<string, ArticleBundle[]>();
  for (const article of lookbackArticles) if (!byManifest.has(article.manifestPath)) byManifest.set(article.manifestPath, []);
  for (const article of articles) byManifest.set(article.manifestPath, [...(byManifest.get(article.manifestPath) ?? []), article]);
  for (const [manifestPath, rows] of byManifest) {
    const runRoot = path.dirname(manifestPath);
    const candidatePath = path.join(runRoot, "candidates.jsonl.gz");
    await writeFile(candidatePath, gzipSync(`${rows.map((row) => JSON.stringify(row.candidate)).join("\n")}\n`, { level: 9 }));
    const manifest = json<SourceCaptureManifest>(await readFile(manifestPath, "utf8"));
    const candidates = rows.map((row) => row.candidate);
    const lookbackCandidates = lookbackArticles.filter((article) => article.manifestPath === manifestPath).length;
    const runFiles = (await filesBelow(runRoot)).filter((target) => target !== manifestPath);
    manifest.candidateCount = candidates.length;
    manifest.fullCount = candidates.filter((candidate) => candidate.contentStatus === "full").length;
    manifest.summaryCount = candidates.filter((candidate) => candidate.contentStatus === "summary").length;
    manifest.metadataCount = candidates.filter((candidate) => candidate.contentStatus === "metadata").length;
    manifest.captureStatus = "pages-complete";
    manifest.healthStatus = candidates.length ? "healthy" : "empty";
    manifest.pageCapture = {
      lookbackCandidates,
      processWindowHours,
      recoveryCandidates: rows.filter((row) => recoveryArticleIds.has(row.articleId)).length,
      planned: candidates.filter((candidate) => candidate.captureStatus !== "unchanged").length,
      captured: candidates.filter((candidate) => candidate.captureStatus === "captured").length,
      unchanged: candidates.filter((candidate) => candidate.captureStatus === "unchanged").length,
      failed: candidates.filter((candidate) => candidate.captureStatus === "failed").length,
      skipped: candidates.filter((candidate) => candidate.captureStatus === "skipped").length,
      hardPaywall: candidates.filter((candidate) => candidate.captureStatus === "hard-paywall").length,
      direct: candidates.filter((candidate) => candidate.captureMethod === "direct").length,
      browser: candidates.filter((candidate) => candidate.captureMethod === "browser").length,
      assets: candidates.reduce((sum, candidate) => sum + (candidate.assets?.length ?? 0), 0),
    };
    manifest.objects = await Promise.all(runFiles.map((target) => descriptor(runRoot, target)));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  for (const [sourceId, state] of states) {
    const target = path.join(workspace, "raw", sourceId, "state.json.gz");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, gzipSync(`${JSON.stringify(state)}\n`, { level: 9 }));
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workspace = path.resolve(requiredArg(args, "output"));
  const runPath = path.resolve(requiredArg(args, "run-manifest"));
  const configPath = path.resolve(requiredArg(args, "config"));
  const sourceWorkers = Number(args.get("source-workers") ?? args.get("workers") ?? "4");
  const timeoutSeconds = Number(args.get("timeout") ?? "30");
  const processWindowHours = Number(args.get("process-window-hours") ?? "24");
  const refreshHours = Number(args.get("refresh-hours") ?? "24");
  const retryHours = Number(args.get("retry-hours") ?? "2");
  const rotationAttempts = Number(args.get("proxy-rotation-attempts") ?? "0");
  const proxyExhaustiveTail = Number(args.get("proxy-exhaustive-tail") ?? "0");
  if (![sourceWorkers, timeoutSeconds, processWindowHours, refreshHours, retryHours, rotationAttempts, proxyExhaustiveTail].every(Number.isFinite)
    || !Number.isInteger(sourceWorkers) || sourceWorkers < 1 || timeoutSeconds <= 0 || processWindowHours <= 0
    || refreshHours <= 0 || retryHours <= 0
    || !Number.isInteger(rotationAttempts) || rotationAttempts < 0
    || !Number.isInteger(proxyExhaustiveTail) || proxyExhaustiveTail < 0) {
    throw new Error("Capture workers, timeouts and retry intervals must be valid");
  }
  const run = json<RawRunManifest>(await readFile(runPath, "utf8"));
  const sources = new Map((await loadSources(configPath)).map((source) => [source.id, source]));
  const requested = new Set((args.get("sources") ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  const articles = (await loadArticles(workspace, run, sources)).filter((article) => !requested.size || requested.has(article.sourceId));
  const states = new Map<string, PageCaptureState>();
  for (const sourceId of new Set(articles.map((article) => article.sourceId))) {
    states.set(sourceId, await loadState(path.join(workspace, "raw", sourceId, "state.json.gz")));
  }
  const generatedAt = new Date();
  const pending = pendingArticles(articles, states, { now: generatedAt, retentionDays: 7, refreshHours, retryHours }) as ArticleBundle[];
  const selection = selectRunArticles(articles, pending, { now: generatedAt, processWindowHours });
  const selectedArticles = selection.articles;
  const pendingIds = new Set(pending.map((article) => article.articleId));
  for (const article of selectedArticles) if (!pendingIds.has(article.articleId)) article.candidate.captureStatus = "unchanged";
  const best = new Map<string, CaptureOutcome>();
  const extensionPath = args.get("browser-extension-path") ? path.resolve(args.get("browser-extension-path")!) : undefined;
  const proxyServer = args.get("proxy-server");
  const bravePath = process.env.JOJO_TIMES_BRAVE_PATH?.trim();
  const proxyAttempts = new Map<string, Set<string>>();
  const recordProxyAttempts = (values: readonly ArticleBundle[], candidate: string): void => {
    for (const article of values) {
      const attempts = proxyAttempts.get(article.articleId) ?? new Set<string>();
      attempts.add(candidate);
      proxyAttempts.set(article.articleId, attempts);
    }
  };

  const captureRound = async (values: ArticleBundle[], forceBrowser: boolean, label = forceBrowser ? "proxy retry" : "initial"): Promise<void> => {
    await mapSourceBatches(values, sourceWorkers, async (batch) => {
      const batchStartedAt = Date.now();
      process.stderr.write(`[page-capture] ${batch.sourceId}: ${label} ${batch.articles.length} article(s)\n`);
      const source = sources.get(batch.sourceId)!;
      const browserKind = source.fetch.browser ?? "chromium";
      if (browserKind === "brave" && !bravePath) {
        throw new Error(`${source.id} requires JOJO_TIMES_BRAVE_PATH`);
      }
      let session: BrowserSourceSession | undefined;
      let nativeSession: BrowserSourceSession | undefined;
      const browser = async (): Promise<BrowserSourceSession> => {
        session ??= await BrowserSourceSession.open({
          ...(proxyServer ? { proxyServer } : {}),
          ...(extensionPath ? { extensionPath } : {}),
          ...(browserKind === "brave" && bravePath ? { executablePath: bravePath } : {}),
          requireExtension: source.fetch.bpc,
        });
        return session;
      };
      const nativeBrowser = async (): Promise<BrowserSourceSession> => {
        nativeSession ??= await BrowserSourceSession.open({
          ...(proxyServer ? { proxyServer } : {}),
          requireExtension: false,
        });
        return nativeSession;
      };
      const record = (articleId: string, outcome: CaptureOutcome): void => {
        const previous = best.get(articleId);
        if (!previous || successfulPage(outcome.page, outcome.fullBody) || retryableOutcome(previous)) best.set(articleId, outcome);
      };
      try {
        for (const article of batch.articles) {
          record(article.articleId, await captureOne(workspace, article, timeoutSeconds, browser, forceBrowser));
        }
        if (source.fetch.retryWithoutBpcOnBlocked) {
          const blocked = batch.articles.filter((article) => {
            const outcome = best.get(article.articleId);
            return retryableOutcome(outcome) && [401, 403, 429].includes(outcome?.page.status ?? 0);
          });
          if (blocked.length) {
            process.stderr.write(`[page-capture] ${batch.sourceId}: retrying ${blocked.length} blocked article(s) with a native browser profile\n`);
            for (const article of blocked) {
              record(article.articleId, await captureOne(workspace, article, timeoutSeconds, nativeBrowser, true));
            }
          }
        }
      } finally {
        await session?.close();
        await nativeSession?.close();
        const outcomes = batch.articles.map((article) => best.get(article.articleId));
        const captured = outcomes.filter((outcome) => outcome?.fullBody).length;
        const failed = outcomes.length - captured;
        process.stderr.write(`[page-capture] ${batch.sourceId}: ${captured} full, ${failed} failed in ${Math.ceil((Date.now() - batchStartedAt) / 1_000)}s\n`);
      }
    });
  };

  await captureRound(pending, false);
  const controlUrl = args.get("proxy-control-url");
  const proxyGroup = args.get("proxy-group") ?? "JOJO-TIMES-ROUTE";
  const automaticName = args.get("proxy-automatic-name") ?? "JOJO-TIMES-AUTO";
  const probeOffsets = new Map<string, number>();
  let rotationRounds = 0;
  let proxyTailRounds = 0;
  let selectedProxyCandidates: string[] = [];
  if (pending.length && proxyServer && controlUrl && rotationAttempts > 0) {
    try {
      selectedProxyCandidates = await proxyCandidates(controlUrl, proxyGroup, automaticName, rotationAttempts);
      for (const alternative of selectedProxyCandidates) {
        const failed = pending.filter((article) => article.source.fetch.proxyPolicy === "rotate"
          && retryableOutcome(best.get(article.articleId)));
        if (!failed.length) break;
        await selectProxy(controlUrl, proxyGroup, alternative);
        await new Promise((resolve) => setTimeout(resolve, 250));
        const probes = rotatingSourceProbes(failed, probeOffsets);
        recordProxyAttempts(probes, alternative);
        await captureRound(probes, true);
        const usableSources = new Set(probes.filter((article) => {
          const outcome = best.get(article.articleId);
          return Boolean(outcome && successfulPage(outcome.page, outcome.fullBody));
        }).map((article) => article.sourceId));
        const remaining = failed.filter((article) => usableSources.has(article.sourceId) && retryableOutcome(best.get(article.articleId)));
        if (remaining.length) {
          recordProxyAttempts(remaining, alternative);
          await captureRound(remaining, true);
        }
        rotationRounds += 1;
      }

      const failedAfterProbes = pending.filter((article) => article.source.fetch.proxyPolicy === "rotate"
        && retryableOutcome(best.get(article.articleId)));
      const tailSources = proxyTailSourceIds(failedAfterProbes, proxyExhaustiveTail);
      if (tailSources.size) {
        process.stderr.write(`[page-capture] exhaustive proxy tail: ${failedAfterProbes.filter((article) => tailSources.has(article.sourceId)).length} article(s) across ${tailSources.size} source(s)\n`);
      }
      for (const alternative of selectedProxyCandidates) {
        const stillFailed = pending.filter((article) => article.source.fetch.proxyPolicy === "rotate"
          && retryableOutcome(best.get(article.articleId)));
        const untried = untriedProxyArticles(stillFailed, tailSources, proxyAttempts, alternative);
        if (!untried.length) continue;
        await selectProxy(controlUrl, proxyGroup, alternative);
        await new Promise((resolve) => setTimeout(resolve, 250));
        recordProxyAttempts(untried, alternative);
        await captureRound(untried, true, "exhaustive proxy tail");
        proxyTailRounds += 1;
      }
    } finally {
      await selectProxy(controlUrl, proxyGroup, automaticName);
    }
  }

  for (const article of pending) {
    const outcome = best.get(article.articleId);
    const state = states.get(article.sourceId)!;
    state.articles[article.articleId] = {
      fingerprint: articleFingerprint(article),
      lastAttempt: generatedAt.toISOString(),
      ...(outcome?.page.capturedAt ? { capturedAt: outcome.page.capturedAt } : {}),
      ...(outcome?.page.status !== undefined ? { httpStatus: outcome.page.status } : {}),
      error: outcome?.fullBody || outcome?.unavailableReason ? null : outcome?.page.error ?? "FullTextNotExtracted",
      ...(outcome?.unavailableReason ? { unavailableReason: outcome.unavailableReason } : {}),
      ...(outcome?.rawPageObject ? { rawPageObject: outcome.rawPageObject } : {}),
    };
    state.updatedAt = generatedAt.toISOString();
  }
  await persistSources(
    workspace,
    selectedArticles,
    articles,
    states,
    processWindowHours,
    selection.recoveryArticleIds,
  );
  const outcomes = [...best.values()];
  const failures = pending.flatMap((article) => {
    const outcome = best.get(article.articleId);
    if (outcome?.fullBody || outcome?.unavailableReason) return [];
    return [{
      sourceId: article.sourceId,
      articleId: article.articleId,
      title: article.candidate.title,
      canonicalUrl: article.candidate.canonicalUrl,
      publishedAt: article.candidate.publishedAt,
      ...(outcome?.page.status !== undefined ? { httpStatus: outcome.page.status } : {}),
      error: outcome?.page.error ?? "FullTextNotExtracted",
      ...(outcome?.bodyAssessment ? { bodyAssessment: outcome.bodyAssessment } : {}),
      proxyCandidatesTried: proxyAttempts.get(article.articleId)?.size ?? 0,
      proxyCandidatesSelected: selectedProxyCandidates.length,
    }];
  });
  const perSource = [...new Set(articles.map((article) => article.sourceId))].sort().map((sourceId) => {
    const sourceArticles = selectedArticles.filter((article) => article.sourceId === sourceId);
    const sourceLookbackArticles = articles.filter((article) => article.sourceId === sourceId);
    const sourcePending = pending.filter((article) => article.sourceId === sourceId);
    const sourceOutcomes = sourcePending.map((article) => best.get(article.articleId)).filter((outcome): outcome is CaptureOutcome => Boolean(outcome));
    return {
      sourceId,
      discovered: sourceArticles.length,
      lookbackDiscovered: sourceLookbackArticles.length,
      recoveryCandidates: sourceArticles.filter((article) => selection.recoveryArticleIds.has(article.articleId)).length,
      planned: sourcePending.length,
      captured: sourceOutcomes.filter((outcome) => outcome.fullBody).length,
      failed: sourceOutcomes.filter((outcome) => !outcome.fullBody && !outcome.unavailableReason).length,
      skipped: sourceOutcomes.filter((outcome) => outcome.unavailableReason === "UnsupportedMedia").length,
      hardPaywall: sourceOutcomes.filter((outcome) => outcome.unavailableReason === "HardPaywall").length,
      unchanged: sourceArticles.length - sourcePending.length,
      assets: sourceOutcomes.reduce((sum, outcome) => sum + outcome.assetCount, 0),
    };
  });
  const report = {
    formatVersion: "jojo-page-capture-run/1",
    runId: run.runId,
    generatedAt: generatedAt.toISOString(),
    discovered: selectedArticles.length,
    lookbackDiscovered: articles.length,
    processWindowHours,
    recoveryCandidates: selection.recoveryArticleIds.size,
    planned: pending.length,
    captured: outcomes.filter((outcome) => outcome.fullBody).length,
    failed: outcomes.filter((outcome) => !outcome.fullBody && !outcome.unavailableReason).length,
    skipped: outcomes.filter((outcome) => outcome.unavailableReason === "UnsupportedMedia").length,
    hardPaywall: outcomes.filter((outcome) => outcome.unavailableReason === "HardPaywall").length,
    assets: outcomes.reduce((sum, outcome) => sum + outcome.assetCount, 0),
    direct: outcomes.filter((outcome) => outcome.page.method === "direct").length,
    browser: outcomes.filter((outcome) => outcome.page.method === "browser").length,
    sourceWorkers,
    perSourceWorkers: 1,
    proxyRotationRounds: rotationRounds,
    proxyTailRounds,
    proxyCandidatesSelected: selectedProxyCandidates.length,
    proxyExhaustiveTail,
    perSource,
    failures,
  };
  run.pageCapture = report;
  await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`);
  const reportBody = `${JSON.stringify(report, null, 2)}\n`;
  const reportPath = args.get("report");
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(path.resolve(reportPath), reportBody);
  } else {
    process.stdout.write(reportBody);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
