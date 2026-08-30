import { gunzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, requiredArg } from "./args.js";
import { loadSources } from "./config.js";
import { processArticle } from "./process/article.js";
import { writeCanonicalSource, type CanonicalWriteResult } from "./process/canonical-writer.js";
import { restoreTranslationContext } from "./process/translation-retry.js";
import { processSourceCandidate, sourceBodyExtractor, sourceFetchPolicy } from "./sources/registry.js";
import { geminiApiKeysFromEnvironment } from "./translation/api-keys.js";
import {
  TIMES_TRANSLATION_DEFAULTS,
  TIMES_TRANSLATION_POLICY,
  translateProcessedCandidates,
  type TranslationBatchStats,
} from "./translation/gemma.js";
import type { Candidate, SourceCaptureManifest } from "./types.js";
import type { ProcessedCandidate } from "./process/article.js";

interface RawRunManifest {
  runId: string;
  sources: Array<{ sourceId: string; status: "ok" | "empty" | "error"; output?: { manifest?: string } }>;
}

interface ProcessBatch {
  source: Awaited<ReturnType<typeof loadSources>>[number];
  manifest: SourceCaptureManifest;
  manifestObject: string;
  candidates: ProcessedCandidate[];
}

function enabled(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Expected true or false, received ${value}`);
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export async function runProcess(args: Map<string, string>): Promise<{
  report: string;
  translation: ({ enabled: true } & TranslationBatchStats) | { enabled: false };
  sources: CanonicalWriteResult[];
}> {
  const output = path.resolve(requiredArg(args, "output"));
  const runManifestPath = path.resolve(requiredArg(args, "run-manifest"));
  const configPath = path.resolve(requiredArg(args, "config"));
  const rawRevision = args.get("raw-revision") ?? "local";
  const apiKeys = geminiApiKeysFromEnvironment();
  const translationEnabled = enabled(args.get("translate"), apiKeys.length > 0);
  if (translationEnabled && apiKeys.length === 0) {
    throw new Error("GEMINI_API_KEYS or GEMINI_API_KEY is required when Times translation is enabled");
  }
  const sources = new Map((await loadSources(configPath)).map((source) => [source.id, source]));
  const run = JSON.parse(await readFile(runManifestPath, "utf8")) as RawRunManifest;
  const results: CanonicalWriteResult[] = [];
  const batches: ProcessBatch[] = [];
  for (const row of run.sources) {
    if (row.status !== "ok" || !row.output?.manifest) continue;
    const source = sources.get(row.sourceId);
    if (!source) continue;
    const manifestPath = path.join(output, ...row.output.manifest.split("/"));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SourceCaptureManifest;
    const candidatesPath = path.join(path.dirname(manifestPath), "candidates.jsonl.gz");
    const rawCandidates = gunzipSync(await readFile(candidatesPath)).toString("utf8")
      .split(/\r?\n/).filter(Boolean)
      .map((line) => processSourceCandidate(source.id, JSON.parse(line) as Candidate));
    const candidates = await Promise.all(rawCandidates.map((candidate) => processArticle(
      output,
      source,
      candidate,
      manifest.fetchPolicy ?? sourceFetchPolicy(source.id),
      sourceBodyExtractor(source.id),
    )));
    batches.push({ source, manifest, manifestObject: row.output.manifest, candidates });
  }
  let translation: ({ enabled: true } & TranslationBatchStats) | { enabled: false } = { enabled: false };
  if (translationEnabled) {
    for (const batch of batches) {
      batch.candidates = await restoreTranslationContext(output, batch.candidates, "zh-CN", TIMES_TRANSLATION_POLICY);
    }
    const primaryModel = args.get("translation-model") ?? process.env.JOJO_TIMES_TRANSLATION_MODEL;
    const fallbackModel = args.get("translation-fallback-model") ?? process.env.JOJO_TIMES_TRANSLATION_FALLBACK_MODEL;
    const rescueModel = args.get("translation-rescue-model") ?? process.env.JOJO_TIMES_TRANSLATION_RESCUE_MODEL;
    const translated = await translateProcessedCandidates(output, batches.flatMap((batch) => batch.candidates), {
      apiKeys,
      ...(primaryModel ? { primaryModel } : {}),
      ...(fallbackModel ? { fallbackModel } : {}),
      ...(rescueModel ? { rescueModel } : {}),
      workers: positiveInteger(args.get("translation-workers") ?? process.env.JOJO_TIMES_TRANSLATION_WORKERS, TIMES_TRANSLATION_DEFAULTS.workers, "Translation workers"),
      requestTimeoutMs: positiveInteger(args.get("translation-request-timeout-ms") ?? process.env.JOJO_TIMES_TRANSLATION_REQUEST_TIMEOUT_MS, TIMES_TRANSLATION_DEFAULTS.requestTimeoutMs, "Translation request timeout"),
      batchTimeoutMs: positiveInteger(args.get("translation-batch-timeout-ms") ?? process.env.JOJO_TIMES_TRANSLATION_BATCH_TIMEOUT_MS, TIMES_TRANSLATION_DEFAULTS.batchTimeoutMs, "Translation batch timeout"),
      maxChunkCharacters: positiveInteger(args.get("translation-chunk-characters") ?? process.env.JOJO_TIMES_TRANSLATION_CHUNK_CHARACTERS, TIMES_TRANSLATION_DEFAULTS.maxChunkCharacters, "Translation chunk size"),
      onProgress: (message) => { process.stderr.write(`${message}\n`); },
    });
    const byId = new Map(translated.candidates.map((candidate) => [candidate.articleId, candidate]));
    for (const batch of batches) batch.candidates = batch.candidates.map((candidate) => byId.get(candidate.articleId) ?? candidate);
    translation = { enabled: true, ...translated.stats };
  }
  for (const batch of batches) {
    results.push(await writeCanonicalSource(
      output,
      batch.source,
      batch.manifest,
      batch.manifestObject,
      batch.candidates,
      rawRevision,
    ));
  }
  const reportPath = path.join(output, "canonical", "runs", `${run.runId}.json`);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({
    formatVersion: "jojo-times-canonical-run/2",
    runId: run.runId,
    rawRevision,
    processedAt: new Date().toISOString(),
    translation,
    sources: results,
  }, null, 2)}\n`);
  return { report: reportPath, translation, sources: results };
}

async function main(): Promise<void> {
  process.stdout.write(`${JSON.stringify(await runProcess(parseArgs(process.argv.slice(2))), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
