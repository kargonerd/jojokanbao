import { datasetInfo, downloadFile, HubApiError, listFiles, uploadFiles } from "@huggingface/hub";
import { gunzipSync } from "node:zlib";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/u.test(value)) continue;
    const candidate = value.slice(0, 10);
    if (!Number.isNaN(Date.parse(`${candidate}T00:00:00Z`))) dates.add(candidate);
  }
  return dates;
}

export function canonicalObjects(sourceId: string, dates: ReadonlySet<string>): Set<string> {
  const root = path.posix.join("canonical", sourceId);
  return new Set([
    path.posix.join(root, "dataset.json"),
    ...[...dates].map((date) => path.posix.join(root, "dates", date.slice(0, 4), date.slice(5, 7), `${date}.json.gz`)),
  ]);
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

  async revision(): Promise<string> {
    const info = await retryTransientHf(() => datasetInfo({
      name: this.repo.name,
      accessToken: this.accessToken,
      additionalFields: ["sha"],
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
    const restored = (await mapLimit(states, 8, async (objectName) => (
      await this.downloadObject(objectName, revision) ? objectName : null
    ))).filter((objectName): objectName is string => objectName !== null);
    return { restored: restored.length, objects: restored };
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
        assets: candidateAssets(bytes),
        rawPages: candidateRawPages(bytes),
      };
    });
    const rawAssets = new Set<string>();
    for (const bundle of bundles) for (const objectName of bundle.assets) rawAssets.add(objectName);
    await mapLimit([...rawAssets], 8, async (objectName) => this.downloadObject(objectName, latest.revision));
    const rawPages = new Set<string>();
    for (const bundle of bundles) for (const objectName of bundle.rawPages) rawPages.add(objectName);
    const rawPageFileCounts = await mapLimit([...rawPages], 8, async (metadataObject) => {
      const metadataFile = await this.downloadObject(metadataObject, latest.revision);
      if (!metadataFile) throw new Error(`HF Raw page metadata is missing: ${metadataObject}`);
      const metadata = JSON.parse(await readFile(metadataFile, "utf8")) as { renderedHtml?: unknown };
      if (metadata.renderedHtml === null || metadata.renderedHtml === undefined) return 1;
      if (typeof metadata.renderedHtml !== "string") throw new Error(`HF Raw page metadata is invalid: ${metadataObject}`);
      const renderedObject = safeRawObject(metadataObject, metadata.renderedHtml);
      if (!await this.downloadObject(renderedObject, latest.revision)) {
        throw new Error(`HF Raw rendered page is missing: ${renderedObject}`);
      }
      return 2;
    });
    const wanted = new Set<string>();
    for (const bundle of bundles) for (const objectName of canonicalObjects(bundle.sourceId, bundle.dates)) wanted.add(objectName);
    const existing = await this.treeFiles("canonical", latest.revision);
    const canonical = [...wanted].filter((objectName) => existing.has(objectName)).sort();
    await mapLimit(canonical, 8, async (objectName) => this.downloadObject(objectName, latest.revision));
    return {
      revision: latest.revision,
      runId: latest.run.runId,
      runObject: latest.objectName,
      runManifest: path.resolve(latest.file),
      sources: rows.length,
      rawFiles: 1 + rows.length * 2 + rawAssets.size + rawPageFileCounts.reduce((sum, count) => sum + count, 0),
      canonicalFiles: canonical.length,
    };
  }

  async downloadLatestSnapshot(): Promise<Record<string, unknown>> {
    return this.downloadSnapshot();
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
