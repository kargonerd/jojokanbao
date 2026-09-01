import { datasetInfo, downloadFile, HubApiError, listFiles, uploadFiles } from "@huggingface/hub";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { gunzipSync } from "node:zlib";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sourceOriginalPageRejectionClassifier } from "./sources/registry.js";
import { TIMES_TRANSLATION_POLICY } from "./translation/gemma.js";

const RAW_RUN_ROOT = "raw/runs";
const DATASET_REPO_TYPE = "dataset" as const;
const SOURCE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

interface RunSourceRow {
  sourceId?: unknown;
  output?: { manifest?: unknown };
}

interface RawRunManifest {
  runId?: unknown;
  complete?: unknown;
  sources?: unknown;
}

interface SourceManifest {
  objects?: unknown;
}

export interface HfFileSetEntry {
  localPath: string;
  objectName: string;
  size: number;
  sha256: string;
  required: boolean;
}

export interface HfFileSetManifest {
  formatVersion: "jojo-hf-file-set/1";
  files: HfFileSetEntry[];
}

export type HfConflictStrategy = "fail" | "retry-disjoint";

function strictRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
  const components = value.split("/");
  if (
    path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || /^[a-z]:/iu.test(value)
    || components.some((component) => !component || component === "." || component === "..")
    || path.posix.normalize(value) !== value
  ) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  return value;
}

export function parseHfFileSetManifest(value: unknown): HfFileSetManifest {
  if (!value || typeof value !== "object") throw new Error("HF file-set manifest must be an object");
  const input = value as { formatVersion?: unknown; files?: unknown };
  const topLevelFields = Object.keys(input);
  if (topLevelFields.length !== 2 || !topLevelFields.includes("formatVersion") || !topLevelFields.includes("files")) {
    throw new Error("HF file-set manifest must contain only formatVersion and files");
  }
  if (input.formatVersion !== "jojo-hf-file-set/1") {
    throw new Error(`Unsupported HF file-set format: ${String(input.formatVersion)}`);
  }
  if (!Array.isArray(input.files)) throw new Error("HF file-set manifest files must be an array");
  const objectNames = new Set<string>();
  const localPaths = new Set<string>();
  const files = input.files.map((file, index): HfFileSetEntry => {
    if (!file || typeof file !== "object") throw new Error(`HF file-set entry ${index} must be an object`);
    const row = file as {
      localPath?: unknown;
      objectName?: unknown;
      size?: unknown;
      sha256?: unknown;
      required?: unknown;
    };
    const allowedFields = new Set(["localPath", "objectName", "size", "sha256", "required"]);
    const rowFields = Object.keys(row);
    if (rowFields.some((field) => !allowedFields.has(field))) {
      throw new Error(`HF file-set entry ${index} has unsupported fields`);
    }
    const localPath = strictRelativePath(row.localPath, `HF local path at entry ${index}`);
    const objectName = strictRelativePath(row.objectName, `HF object path at entry ${index}`);
    if (!Number.isSafeInteger(row.size) || (row.size as number) < 0) {
      throw new Error(`Invalid HF file size at entry ${index}: ${String(row.size)}`);
    }
    if (typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.sha256)) {
      throw new Error(`Invalid HF SHA-256 at entry ${index}: ${String(row.sha256)}`);
    }
    if (row.required !== undefined && typeof row.required !== "boolean") {
      throw new Error(`Invalid HF required flag at entry ${index}: ${String(row.required)}`);
    }
    if (objectNames.has(objectName)) throw new Error(`Duplicate HF object name: ${objectName}`);
    if (localPaths.has(localPath)) throw new Error(`Duplicate HF local path: ${localPath}`);
    objectNames.add(objectName);
    localPaths.add(localPath);
    return {
      localPath,
      objectName,
      size: row.size as number,
      sha256: row.sha256,
      required: row.required ?? true,
    };
  });
  return { formatVersion: "jojo-hf-file-set/1", files };
}

export async function readHfFileSetManifest(file: string): Promise<HfFileSetManifest> {
  return parseHfFileSetManifest(JSON.parse(await readFile(path.resolve(file), "utf8")) as unknown);
}

function resolvedOutputPath(output: string, localPath: string): string {
  const root = path.resolve(output);
  const target = path.resolve(root, ...localPath.split("/"));
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Unsafe HF local path: ${localPath}`);
  }
  return target;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function missingFileError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function existingFileWithinOutput(output: string, localPath: string): Promise<string> {
  const root = await realpath(path.resolve(output));
  const candidate = resolvedOutputPath(output, localPath);
  const physical = await realpath(candidate);
  if (!pathIsWithin(root, physical)) throw new Error(`HF local path escapes the output root: ${localPath}`);
  return physical;
}

async function nearestExistingDirectory(directory: string): Promise<string> {
  let candidate = directory;
  for (;;) {
    try {
      return await realpath(candidate);
    } catch (error) {
      if (!missingFileError(error)) throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function downloadTargetWithinOutput(output: string, outputRoot: string, localPath: string): Promise<string> {
  const target = resolvedOutputPath(output, localPath);
  const parent = path.dirname(target);
  const ancestor = await nearestExistingDirectory(parent);
  if (!pathIsWithin(outputRoot, ancestor)) throw new Error(`HF local path escapes the output root: ${localPath}`);
  await mkdir(parent, { recursive: true });
  const physicalParent = await realpath(parent);
  if (!pathIsWithin(outputRoot, physicalParent)) throw new Error(`HF local path escapes the output root: ${localPath}`);
  return target;
}

export function rawRunMatchesGitHubRunId(runId: unknown, githubRunId: string): boolean {
  return /^\d+$/u.test(githubRunId)
    && typeof runId === "string"
    && runId.endsWith(`-${githubRunId}`);
}

export function rawStateObjects(sourceIds: readonly string[]): string[] {
  const unique = [...new Set(sourceIds)].sort();
  for (const sourceId of unique) {
    if (!SOURCE_ID.test(sourceId)) throw new Error(`Invalid source id for HF state: ${sourceId}`);
  }
  return unique.map((sourceId) => path.posix.join("raw", sourceId, "state.json.gz"));
}

export function safeRawObject(baseObject: string, relativeObject: string): string {
  const normalized = relativeObject.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe Raw object path: ${relativeObject}`);
  }
  return path.posix.join(path.posix.dirname(baseObject), normalized);
}

export function candidateObject(manifestObject: string, manifest: SourceManifest): string {
  if (!Array.isArray(manifest.objects)) throw new Error(`Raw source manifest has no candidates object: ${manifestObject}`);
  for (const value of manifest.objects) {
    if (!value || typeof value !== "object") continue;
    const objectPath = (value as { path?: unknown }).path;
    if (typeof objectPath === "string" && path.posix.basename(objectPath) === "candidates.jsonl.gz") {
      return safeRawObject(manifestObject, objectPath);
    }
  }
  throw new Error(`Raw source manifest has no candidates object: ${manifestObject}`);
}

export function candidateDates(compressed: Uint8Array): Set<string> {
  const dates = new Set<string>();
  for (const line of gunzipSync(compressed).toString("utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const value = (JSON.parse(line) as { publishedAt?: unknown }).publishedAt;
    if (typeof value !== "string") continue;
    const publishedAt = new Date(value);
    if (!Number.isNaN(publishedAt.getTime())) dates.add(publishedAt.toISOString().slice(0, 10));
  }
  return dates;
}

export function candidateUnchangedArticleIds(compressed: Uint8Array): Set<string> {
  const articleIds = new Set<string>();
  for (const line of gunzipSync(compressed).toString("utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const candidate = JSON.parse(line) as { articleId?: unknown; captureStatus?: unknown };
    if (candidate.captureStatus === "unchanged" && typeof candidate.articleId === "string") {
      articleIds.add(candidate.articleId);
    }
  }
  return articleIds;
}

export function candidateArticleIds(compressed: Uint8Array): Set<string> {
  const articleIds = new Set<string>();
  for (const line of gunzipSync(compressed).toString("utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const articleId = (JSON.parse(line) as { articleId?: unknown }).articleId;
    if (typeof articleId === "string") articleIds.add(articleId);
  }
  return articleIds;
}

export function canonicalObjects(sourceId: string, dates: ReadonlySet<string>): Set<string> {
  const root = path.posix.join("canonical", sourceId);
  return new Set([
    path.posix.join(root, "dataset.json"),
    ...[...dates].map((date) => path.posix.join(root, "dates", date.slice(0, 4), date.slice(5, 7), `${date}.json.gz`)),
  ]);
}

export function canonicalTranslationObjects(
  existing: ReadonlySet<string>,
  datesBySource: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const selected = new Set<string>();
  const pattern = new RegExp(`^canonical/([a-z0-9]+(?:-[a-z0-9]+)*)/translations/${TIMES_TRANSLATION_POLICY}/(\\d{4})/(\\d{2})/(\\d{4}-\\d{2}-\\d{2})/[a-f0-9]{64}\\.json\\.gz$`, "u");
  for (const objectName of existing) {
    const match = pattern.exec(objectName);
    const sourceId = match?.[1];
    const date = match?.[4];
    if (sourceId && date && datesBySource.get(sourceId)?.has(date)) selected.add(objectName);
  }
  return selected;
}

export function referencedCanonicalArticleObjects(
  compressed: Uint8Array,
  sourceId: string,
  articleIds: ReadonlySet<string>,
): Set<string> {
  const parsed = JSON.parse(gunzipSync(compressed).toString("utf8")) as {
    articles?: Array<{ articleId?: unknown; object?: unknown }>;
  };
  const selected = new Set<string>();
  const expectedRoot = path.posix.join("canonical", sourceId, "articles");
  for (const row of parsed.articles ?? []) {
    if (typeof row.articleId !== "string" || !articleIds.has(row.articleId) || typeof row.object !== "string") continue;
    const normalized = row.object.replaceAll("\\", "/");
    if (path.posix.dirname(normalized) !== expectedRoot || !normalized.endsWith(".json.gz")) {
      throw new Error(`Invalid Canonical article object for ${row.articleId}: ${row.object}`);
    }
    selected.add(normalized);
  }
  return selected;
}

export function canonicalArticleAssets(compressed: Uint8Array): Set<string> {
  const parsed = JSON.parse(gunzipSync(compressed).toString("utf8")) as {
    assets?: Array<{ rawObject?: unknown }>;
  };
  return new Set((parsed.assets ?? [])
    .map((asset) => asset.rawObject)
    .filter((objectName): objectName is string => typeof objectName === "string"));
}

export function candidateAssets(compressed: Uint8Array): Set<string> {
  const objects = new Set<string>();
  for (const line of gunzipSync(compressed).toString("utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const assets = (JSON.parse(line) as { assets?: Array<{ rawObject?: unknown }> }).assets;
    if (!Array.isArray(assets)) continue;
    for (const asset of assets) if (typeof asset.rawObject === "string") objects.add(asset.rawObject);
  }
  return objects;
}

export function candidateRawPages(compressed: Uint8Array): Set<string> {
  const objects = new Set<string>();
  for (const line of gunzipSync(compressed).toString("utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const rawPageObject = (JSON.parse(line) as { rawPageObject?: unknown }).rawPageObject;
    if (typeof rawPageObject === "string") objects.add(rawPageObject);
  }
  return objects;
}

export function rawPageHtmlObjects(
  metadataObject: string,
  metadata: { originalHtml?: unknown; renderedHtml?: unknown },
  includeOriginal: boolean,
): string[] {
  const values: string[] = [];
  const append = (value: unknown, label: "originalHtml" | "renderedHtml"): void => {
    if (value === null || value === undefined) return;
    if (typeof value !== "string") throw new Error(`HF Raw page ${label} is invalid: ${metadataObject}`);
    values.push(safeRawObject(metadataObject, value));
  };
  append(metadata.renderedHtml, "renderedHtml");
  if (includeOriginal) append(metadata.originalHtml, "originalHtml");
  return values;
}

function localObjectPath(output: string, objectName: string): string {
  const normalized = objectName.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe HF object path: ${objectName}`);
  }
  const resolved = path.resolve(output, ...normalized.split("/"));
  const root = path.resolve(output);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Unsafe HF object path: ${objectName}`);
  return resolved;
}

async function mapLimit<T, R>(values: readonly T[], concurrency: number, work: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  async function consume(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) return;
      const value = values[index];
      if (value !== undefined) output[index] = await work(value);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, consume));
  return output;
}

interface HfRetryOptions {
  attempts?: number;
  delayMs?: number;
  label?: string;
}

function hfStatusCode(error: unknown): number | undefined {
  if (error instanceof HubApiError) return error.statusCode;
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function transientHfError(error: unknown): boolean {
  const status = hfStatusCode(error);
  return error instanceof TypeError
    || status === 408
    || status === 425
    || status === 429
    || (status !== undefined && status >= 500 && status <= 599);
}

export async function retryTransientHf<T>(
  work: () => Promise<T>,
  options: HfRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 4;
  const delayMs = options.delayMs ?? 1_000;
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("HF retry attempts must be a positive integer");
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("HF retry delay must be non-negative");
  for (let attempt = 1;; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= attempts || !transientHfError(error)) throw error;
      const status = hfStatusCode(error);
      const reason = status ? `HTTP ${status}` : error instanceof Error ? error.name : "network error";
      const waitMs = Math.min(delayMs * 2 ** (attempt - 1), 10_000);
      process.stderr.write(`[hf] ${options.label ?? "request"} returned ${reason}; retry ${attempt + 1}/${attempts} in ${waitMs}ms\n`);
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

export class HfTimesDataset {
  readonly repo: { type: typeof DATASET_REPO_TYPE; name: string };

  constructor(
    repoId: string,
    private readonly output: string,
    private readonly accessToken: string,
  ) {
    this.repo = { type: DATASET_REPO_TYPE, name: repoId };
  }

  async revision(requestedRevision?: string): Promise<string> {
    const info = await retryTransientHf(() => datasetInfo({
      name: this.repo.name,
      accessToken: this.accessToken,
      additionalFields: ["sha"],
      ...(requestedRevision ? { revision: requestedRevision } : {}),
    }), { label: "dataset metadata" });
    if (typeof info.sha !== "string" || !info.sha) throw new Error("HF Dataset did not return a revision");
    return info.sha;
  }

  async treeFiles(root: string, revision: string): Promise<Set<string>> {
    try {
      return await retryTransientHf(async () => {
        const files = new Set<string>();
        for await (const row of listFiles({
          repo: this.repo,
          accessToken: this.accessToken,
          path: root,
          revision,
          recursive: true,
        })) {
          if (row.type === "file") files.add(row.path);
        }
        return files;
      }, { label: `dataset tree ${root}` });
    } catch (error) {
      if (error instanceof HubApiError && error.statusCode === 404) return new Set<string>();
      throw error;
    }
  }

  async downloadObject(objectName: string, revision = "main"): Promise<string | null> {
    const target = localObjectPath(this.output, objectName);
    const body = await retryTransientHf(async () => {
      const blob = await downloadFile({
        repo: this.repo,
        accessToken: this.accessToken,
        path: objectName,
        revision,
      });
      return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    }, { label: `download ${objectName}` });
    if (!body) return null;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
    return target;
  }

  async restoreState(sourceIds: readonly string[]): Promise<{ restored: number; objects: string[] }> {
    const revision = await this.revision();
    const states = rawStateObjects(sourceIds);
    const restored = await mapLimit(states, 8, async (objectName) => ({
      objectName,
      file: await this.downloadObject(objectName, revision),
    }));
    const objects = restored.filter((row) => row.file !== null).map((row) => row.objectName);
    return { restored: objects.length, objects };
  }

  async completeRun(githubRunId?: string): Promise<{ revision: string; objectName: string; file: string; run: RawRunManifest }> {
    if (githubRunId !== undefined && !/^\d+$/u.test(githubRunId)) {
      throw new Error(`Invalid GitHub Actions Capture run id: ${githubRunId}`);
    }
    const revision = await this.revision();
    const runObjects = [...await this.treeFiles(RAW_RUN_ROOT, revision)]
      .filter((objectName) => objectName.endsWith(".json"))
      .sort()
      .reverse();
    const candidates = githubRunId === undefined
      ? runObjects
      : runObjects.filter((objectName) => path.posix.basename(objectName).endsWith(`-${githubRunId}.json`));
    for (const objectName of candidates) {
      const file = await this.downloadObject(objectName, revision);
      if (!file) continue;
      const run = JSON.parse(await readFile(file, "utf8")) as RawRunManifest;
      if (run.complete === true && (githubRunId === undefined || rawRunMatchesGitHubRunId(run.runId, githubRunId))) {
        return { revision, objectName, file, run };
      }
    }
    if (githubRunId !== undefined) {
      throw new Error(`HF Raw has no complete Times run for GitHub Actions Capture run ${githubRunId}`);
    }
    throw new Error("HF Raw has no complete Times run manifest");
  }

  async downloadSnapshot(githubRunId?: string): Promise<Record<string, unknown>> {
    const latest = await this.completeRun(githubRunId);
    const rows = Array.isArray(latest.run.sources)
      ? (latest.run.sources as RunSourceRow[]).filter((row) => (
          typeof row.sourceId === "string" && typeof row.output?.manifest === "string"
        ))
      : [];
    const bundles = await mapLimit(rows, 8, async (row) => {
      const sourceId = row.sourceId as string;
      const manifestObject = row.output?.manifest as string;
      const manifestFile = await this.downloadObject(manifestObject, latest.revision);
      if (!manifestFile) throw new Error(`HF Raw source manifest is missing: ${manifestObject}`);
      const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as SourceManifest;
      const candidatesObject = candidateObject(manifestObject, manifest);
      const candidatesFile = await this.downloadObject(candidatesObject, latest.revision);
      if (!candidatesFile) throw new Error(`HF Raw candidates object is missing: ${candidatesObject}`);
      const bytes = await readFile(candidatesFile);
      return {
        sourceId,
        dates: candidateDates(bytes),
        articleIds: candidateArticleIds(bytes),
        unchangedArticleIds: candidateUnchangedArticleIds(bytes),
        assets: candidateAssets(bytes),
        rawPages: candidateRawPages(bytes),
      };
    });
    const rawAssets = new Set<string>();
    for (const bundle of bundles) for (const objectName of bundle.assets) rawAssets.add(objectName);
    await mapLimit([...rawAssets], 8, async (objectName) => this.downloadObject(objectName, latest.revision));
    const rawPages = new Map<string, boolean>();
    for (const bundle of bundles) {
      const includeOriginal = Boolean(sourceOriginalPageRejectionClassifier(bundle.sourceId));
      for (const objectName of bundle.rawPages) {
        rawPages.set(objectName, (rawPages.get(objectName) ?? false) || includeOriginal);
      }
    }
    const rawPageFileCounts = await mapLimit([...rawPages], 8, async ([metadataObject, includeOriginal]) => {
      const metadataFile = await this.downloadObject(metadataObject, latest.revision);
      if (!metadataFile) throw new Error(`HF Raw page metadata is missing: ${metadataObject}`);
      const metadata = JSON.parse(await readFile(metadataFile, "utf8")) as {
        originalHtml?: unknown;
        renderedHtml?: unknown;
      };
      const htmlObjects = rawPageHtmlObjects(metadataObject, metadata, includeOriginal);
      for (const htmlObject of htmlObjects) {
        if (!await this.downloadObject(htmlObject, latest.revision)) {
          throw new Error(`HF Raw page HTML is missing: ${htmlObject}`);
        }
      }
      return 1 + htmlObjects.length;
    });
    const wanted = new Set<string>();
    for (const bundle of bundles) for (const objectName of canonicalObjects(bundle.sourceId, bundle.dates)) wanted.add(objectName);
    const existing = await this.treeFiles("canonical", latest.revision);
    const datesBySource = new Map(bundles.map((bundle) => [bundle.sourceId, bundle.dates]));
    for (const objectName of canonicalTranslationObjects(existing, datesBySource)) wanted.add(objectName);
    const canonical = [...wanted].filter((objectName) => existing.has(objectName)).sort();
    await mapLimit(canonical, 8, async (objectName) => this.downloadObject(objectName, latest.revision));
    const canonicalArticles = new Set<string>();
    const retryCanonicalArticles = new Set<string>();
    for (const bundle of bundles) {
      for (const date of bundle.dates) {
        const indexObject = path.posix.join("canonical", bundle.sourceId, "dates", date.slice(0, 4), date.slice(5, 7), `${date}.json.gz`);
        if (!existing.has(indexObject)) continue;
        const indexFile = localObjectPath(this.output, indexObject);
        const indexBytes = await readFile(indexFile);
        for (const objectName of referencedCanonicalArticleObjects(indexBytes, bundle.sourceId, bundle.articleIds)) {
          if (existing.has(objectName)) canonicalArticles.add(objectName);
        }
        for (const objectName of referencedCanonicalArticleObjects(indexBytes, bundle.sourceId, bundle.unchangedArticleIds)) {
          if (existing.has(objectName)) retryCanonicalArticles.add(objectName);
        }
      }
    }
    await mapLimit([...canonicalArticles], 8, async (objectName) => this.downloadObject(objectName, latest.revision));
    const restoredCanonicalAssets = new Set<string>();
    for (const objectName of retryCanonicalArticles) {
      const articleFile = localObjectPath(this.output, objectName);
      for (const assetObject of canonicalArticleAssets(await readFile(articleFile))) {
        if (!rawAssets.has(assetObject)) restoredCanonicalAssets.add(assetObject);
      }
    }
    await mapLimit([...restoredCanonicalAssets], 8, async (objectName) => this.downloadObject(objectName, latest.revision));
    return {
      revision: latest.revision,
      runId: latest.run.runId,
      runObject: latest.objectName,
      runManifest: path.resolve(latest.file),
      sources: rows.length,
      rawFiles: 1 + rows.length * 2 + rawAssets.size + restoredCanonicalAssets.size + rawPageFileCounts.reduce((sum, count) => sum + count, 0),
      canonicalFiles: canonical.length + canonicalArticles.size,
    };
  }

  async downloadLatestSnapshot(): Promise<Record<string, unknown>> {
    return this.downloadSnapshot();
  }

  async uploadFileSet(
    manifestValue: HfFileSetManifest,
    title: string,
    conflictStrategy: HfConflictStrategy = "fail",
  ): Promise<{ revision: string; uploaded: number; skipped: string[] }> {
    const manifest = parseHfFileSetManifest(manifestValue);
    if (conflictStrategy !== "fail" && conflictStrategy !== "retry-disjoint") {
      throw new Error(`Unsupported HF conflict strategy: ${String(conflictStrategy)}`);
    }

    const selected: Array<{ local: string; objectName: string }> = [];
    const skipped: string[] = [];
    for (const entry of manifest.files) {
      let local: string;
      try {
        local = await existingFileWithinOutput(this.output, entry.localPath);
      } catch (error) {
        if (!missingFileError(error)) throw error;
        if (entry.required) throw new Error(`Required HF upload file is missing: ${entry.localPath}`, { cause: error });
        skipped.push(entry.objectName);
        continue;
      }
      const metadata = await stat(local);
      if (!metadata.isFile()) throw new Error(`HF upload path is not a file: ${entry.localPath}`);
      if (metadata.size !== entry.size) {
        throw new Error(`HF upload size mismatch for ${entry.localPath}: expected ${entry.size}, got ${metadata.size}`);
      }
      const digest = await fileSha256(local);
      if (digest !== entry.sha256) {
        throw new Error(`HF upload SHA-256 mismatch for ${entry.localPath}: expected ${entry.sha256}, got ${digest}`);
      }
      selected.push({ local, objectName: entry.objectName });
    }

    let parentRevision = await this.revision();
    if (selected.length === 0) return { revision: parentRevision, uploaded: 0, skipped };
    const conflictAttempts = conflictStrategy === "retry-disjoint" ? 4 : 1;
    for (let attempt = 1;; attempt += 1) {
      try {
        const result = await retryTransientHf(() => uploadFiles({
          repo: this.repo,
          accessToken: this.accessToken,
          commitTitle: title,
          parentCommit: parentRevision,
          files: selected.map((file) => ({ path: file.objectName, content: pathToFileURL(file.local) })),
          useWebWorkers: false,
          useXet: true,
        }), { label: `upload ${title}` });
        return { revision: result?.commit.oid ?? parentRevision, uploaded: selected.length, skipped };
      } catch (error) {
        if (hfStatusCode(error) !== 409 || attempt >= conflictAttempts) throw error;
        process.stderr.write(`[hf] upload ${title} conflicted; refreshing the parent revision for disjoint retry ${attempt + 1}/${conflictAttempts}\n`);
        parentRevision = await this.revision();
      }
    }
  }

  async downloadFileSet(
    manifestValue: HfFileSetManifest,
    requestedRevision?: string,
  ): Promise<{ revision: string; downloaded: number; skipped: string[] }> {
    const manifest = parseHfFileSetManifest(manifestValue);
    await mkdir(path.resolve(this.output), { recursive: true });
    const outputRoot = await realpath(path.resolve(this.output));
    const revision = await this.revision(requestedRevision);
    const prepared = await mapLimit(manifest.files, 8, async (entry) => {
      let temporary: string | undefined;
      try {
        const target = await downloadTargetWithinOutput(this.output, outputRoot, entry.localPath);
        let body: Uint8Array | null;
        try {
          body = await retryTransientHf(async () => {
            const blob = await downloadFile({
              repo: this.repo,
              accessToken: this.accessToken,
              path: entry.objectName,
              revision,
            });
            return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
          }, { label: `download ${entry.objectName}` });
        } catch (error) {
          if (hfStatusCode(error) !== 404) throw error;
          body = null;
        }
        if (!body) {
          if (entry.required) throw new Error(`Required HF object is missing at revision ${revision}: ${entry.objectName}`);
          return { kind: "skipped" as const, entry };
        }
        temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
        await writeFile(temporary, body, { flag: "wx" });
        const metadata = await stat(temporary);
        if (metadata.size !== entry.size) {
          throw new Error(`HF download size mismatch for ${entry.objectName}: expected ${entry.size}, got ${metadata.size}`);
        }
        const digest = await fileSha256(temporary);
        if (digest !== entry.sha256) {
          throw new Error(`HF download SHA-256 mismatch for ${entry.objectName}: expected ${entry.sha256}, got ${digest}`);
        }
        return { kind: "downloaded" as const, entry, target, temporary };
      } catch (error) {
        return { kind: "error" as const, entry, error, temporary };
      }
    });
    const failed = prepared.find((row) => row.kind === "error");
    if (failed?.kind === "error") {
      await Promise.all(prepared.map(async (row) => {
        if (row.temporary) await rm(row.temporary, { force: true });
      }));
      throw failed.error;
    }
    const downloaded = prepared.filter((row) => row.kind === "downloaded");
    try {
      for (const row of downloaded) {
        if (row.kind === "downloaded") await rename(row.temporary, row.target);
      }
    } catch (error) {
      await Promise.all(downloaded.map(async (row) => {
        if (row.kind === "downloaded") await rm(row.temporary, { force: true });
      }));
      throw error;
    }
    return {
      revision,
      downloaded: downloaded.length,
      skipped: prepared.filter((row) => row.kind === "skipped").map((row) => row.entry.objectName),
    };
  }

  async uploadLocalFiles(files: Array<{ local: string; objectName: string }>, title: string): Promise<string | undefined> {
    if (files.length === 0) throw new Error("No files were selected for HF upload");
    const result = await retryTransientHf(() => uploadFiles({
      repo: this.repo,
      accessToken: this.accessToken,
      commitTitle: title,
      files: files.map((file) => ({ path: file.objectName, content: pathToFileURL(file.local) })),
      useWebWorkers: false,
      useXet: true,
    }), { label: `upload ${title}` });
    return result?.commit.oid;
  }
}

export async function collectFolderFiles(folder: string, objectRoot: string): Promise<Array<{ local: string; objectName: string }>> {
  const root = path.resolve(folder);
  const files: Array<{ local: string; objectName: string }> = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const current = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(current);
      else if (entry.isFile()) {
        const relative = path.relative(root, current).split(path.sep).join("/");
        files.push({ local: current, objectName: path.posix.join(objectRoot, relative) });
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.objectName.localeCompare(right.objectName));
}
