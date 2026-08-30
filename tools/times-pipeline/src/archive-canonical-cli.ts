import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, requiredArg } from "./args.js";
import {
  affectedCanonicalDateObjects,
  archiveAssetObjects,
  deduplicatePreparedRows,
  prepareArchiveRow,
  writeArchiveCanonical,
  type PreparedArchiveRow,
} from "./archive/canonical.js";
import { downloadDirectAsset } from "./capture/http.js";
import { loadSources } from "./config.js";
import { HfTimesDataset, type HfFileSetManifest } from "./hf.js";

interface ArchiveCanonicalReport {
  formatVersion: "jojo-news-archive-canonical-run/1";
  rawRunId: string;
  rawRunManifest: string;
  sourceRawRevision: string;
  rawRevision: string;
  processedAt: string;
  sources: Awaited<ReturnType<typeof writeArchiveCanonical>>;
}

function positiveInteger(value: string | undefined, fallback: number, label: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function safeRelativeObject(value: string, label: string): string {
  const components = value.split("/");
  if (
    !value
    || value.includes("\\")
    || value.startsWith("/")
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || /^[a-z]:/iu.test(value)
    || components.some((component) => !component || component === "." || component === "..")
    || path.posix.normalize(value) !== value
  ) throw new Error(`Unsafe ${label}: ${value}`);
  return value;
}

function localObject(workspace: string, objectName: string): string {
  const normalized = safeRelativeObject(objectName, "local object");
  const root = path.resolve(workspace);
  const target = path.resolve(root, ...normalized.split("/"));
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Object escapes workspace: ${objectName}`);
  }
  return target;
}

async function atomicWrite(target: string, body: Buffer | string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  await writeFile(temporary, body, { flag: "wx" });
  await rename(temporary, target);
}

async function readJsonLines(file: string): Promise<unknown[]> {
  const encoded = await readFile(path.resolve(file));
  const body = file.endsWith(".gz") ? gunzipSync(encoded) : encoded;
  return body.toString("utf8").split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown);
}

async function writePreparedRows(file: string, rows: readonly PreparedArchiveRow[]): Promise<void> {
  const body = Buffer.from(rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  await atomicWrite(path.resolve(file), file.endsWith(".gz") ? gzipSync(body, { level: 9 }) : body);
}

function preparedRow(value: unknown): PreparedArchiveRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Prepared archive row must be an object");
  const row = value as Partial<PreparedArchiveRow>;
  if (
    row.formatVersion !== "jojo-news-canonical-prepared/1"
    || typeof row.sourceRawRevision !== "string"
    || typeof row.rawRunId !== "string"
    || typeof row.rawRunManifest !== "string"
    || typeof row.recordObject !== "string"
    || typeof row.provider !== "string"
    || typeof row.retrievedAt !== "string"
    || !row.candidate
  ) throw new Error("Prepared archive row is incomplete");
  return row as PreparedArchiveRow;
}

async function mapLimit<T, R>(values: readonly T[], concurrency: number, work: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const consume = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      const value = values[index];
      if (value === undefined) return;
      output[index] = await work(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, consume));
  return output;
}

async function fileManifest(workspace: string, objectNames: readonly string[]): Promise<HfFileSetManifest> {
  const files = await Promise.all([...new Set(objectNames)].sort().map(async (objectName) => {
    const localPath = safeRelativeObject(objectName, "HF local path");
    const body = await readFile(localObject(workspace, localPath));
    return {
      localPath,
      objectName: localPath,
      size: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
      required: true,
    };
  }));
  return { formatVersion: "jojo-hf-file-set/1", files };
}

function token(args: Map<string, string>): string {
  const environmentName = args.get("token-env") ?? "HF_TOKEN";
  const value = process.env[environmentName]?.trim();
  if (!value) throw new Error(`${environmentName} is not configured`);
  return value;
}

async function prepare(args: Map<string, string>): Promise<Record<string, unknown>> {
  const workspace = path.resolve(requiredArg(args, "output"));
  const sources = await loadSources(path.resolve(requiredArg(args, "config")));
  const values = await readJsonLines(requiredArg(args, "input"));
  const articleWorkers = positiveInteger(args.get("article-workers"), 4, "Article workers");
  const imageWorkers = positiveInteger(args.get("image-workers"), 4, "Image workers");
  const timeout = positiveInteger(args.get("image-timeout-seconds"), 30, "Image timeout seconds");
  const prepared = deduplicatePreparedRows(await mapLimit(values, articleWorkers, async (value) => prepareArchiveRow({
    value,
    sources,
    workspace,
    imageConcurrency: imageWorkers,
    download: (url, referer) => downloadDirectAsset(url, referer, timeout),
  })));
  const preparedOutput = path.resolve(requiredArg(args, "prepared-output"));
  const assetManifest = path.resolve(requiredArg(args, "asset-manifest"));
  await writePreparedRows(preparedOutput, prepared);
  const manifest = await fileManifest(workspace, archiveAssetObjects(prepared));
  await atomicWrite(assetManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    preparedOutput,
    assetManifest,
    inputs: values.length,
    articles: prepared.length,
    assets: manifest.files.length,
  };
}

async function writeCanonical(args: Map<string, string>): Promise<Record<string, unknown>> {
  const workspace = path.resolve(requiredArg(args, "output"));
  const rawRevision = requiredArg(args, "raw-revision");
  const rows = deduplicatePreparedRows((await readJsonLines(requiredArg(args, "prepared-input"))).map(preparedRow));
  if (!rows.length) throw new Error("Prepared archive batch is empty");
  const rawRunIds = new Set(rows.map((row) => row.rawRunId));
  const rawManifests = new Set(rows.map((row) => row.rawRunManifest));
  const sourceRawRevisions = new Set(rows.map((row) => row.sourceRawRevision));
  if (rawRunIds.size !== 1 || rawManifests.size !== 1 || sourceRawRevisions.size !== 1) {
    throw new Error("Prepared archive batch mixes Raw runs or revisions");
  }
  const dataset = new HfTimesDataset(requiredArg(args, "repo"), workspace, token(args));
  const currentRevision = await dataset.revision();
  if (currentRevision !== rawRevision) {
    throw new Error(`HF changed after archive asset upload: expected ${rawRevision}, found ${currentRevision}`);
  }
  const dateObjects = affectedCanonicalDateObjects(rows);
  const existing = await dataset.treeFiles("canonical", rawRevision);
  await mapLimit(dateObjects.filter((objectName) => existing.has(objectName)), 8, async (objectName) => {
    if (!await dataset.downloadObject(objectName, rawRevision)) throw new Error(`Existing Canonical date disappeared: ${objectName}`);
  });
  const sources = await loadSources(path.resolve(requiredArg(args, "config")));
  const results = await writeArchiveCanonical({ workspace, rows, sources, rawRevision });
  const rawRunId = [...rawRunIds][0]!;
  const rawRunManifest = [...rawManifests][0]!;
  const sourceRawRevision = [...sourceRawRevisions][0]!;
  const processedAt = rows.map((row) => new Date(row.retrievedAt).toISOString()).sort().at(-1)!;
  const report: ArchiveCanonicalReport = {
    formatVersion: "jojo-news-archive-canonical-run/1",
    rawRunId,
    rawRunManifest,
    sourceRawRevision,
    rawRevision,
    processedAt,
    sources: results,
  };
  const reportObject = `canonical/archive-runs/${createHash("sha256").update(rawRunId).digest("hex").slice(0, 24)}.json`;
  await atomicWrite(localObject(workspace, reportObject), `${JSON.stringify(report, null, 2)}\n`);
  const canonicalObjects = [...new Set([...results.flatMap((result) => result.files), reportObject])].sort();
  const canonicalManifest = path.resolve(requiredArg(args, "canonical-manifest"));
  await atomicWrite(canonicalManifest, `${JSON.stringify(await fileManifest(workspace, canonicalObjects), null, 2)}\n`);
  return {
    report: localObject(workspace, reportObject),
    canonicalManifest,
    rawRevision,
    sources: results.length,
    articles: results.reduce((sum, result) => sum + result.articles.length, 0),
    files: canonicalObjects.length,
  };
}

export async function runArchiveCanonical(args: Map<string, string>): Promise<Record<string, unknown>> {
  const action = requiredArg(args, "action");
  if (action === "prepare") return prepare(args);
  if (action === "write") return writeCanonical(args);
  throw new Error(`Unsupported archive canonical action: ${action}`);
}

async function main(): Promise<void> {
  process.stdout.write(`${JSON.stringify(await runArchiveCanonical(parseArgs(process.argv.slice(2))), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
