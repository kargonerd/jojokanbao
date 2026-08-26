import { datasetInfo, downloadFile, HubApiError, listFiles, uploadFiles } from "@huggingface/hub";
import { gunzipSync } from "node:zlib";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const RAW_RUN_ROOT = "raw/runs";
const DATASET_REPO_TYPE = "dataset" as const;

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
    const info = await datasetInfo({
      name: this.repo.name,
      accessToken: this.accessToken,
      additionalFields: ["sha"],
    });
    if (typeof info.sha !== "string" || !info.sha) throw new Error("HF Dataset did not return a revision");
    return info.sha;
  }

  async treeFiles(root: string, revision: string): Promise<Set<string>> {
    const files = new Set<string>();
    try {
      for await (const row of listFiles({
        repo: this.repo,
        accessToken: this.accessToken,
        path: root,
        revision,
        recursive: true,
      })) {
        if (row.type === "file") files.add(row.path);
      }
    } catch (error) {
      if (error instanceof HubApiError && error.statusCode === 404) return files;
      throw error;
    }
    return files;
  }

  async downloadObject(objectName: string, revision = "main"): Promise<string | null> {
    const blob = await downloadFile({
      repo: this.repo,
      accessToken: this.accessToken,
      path: objectName,
      revision,
    });
    if (!blob) return null;
    const target = localObjectPath(this.output, objectName);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, new Uint8Array(await blob.arrayBuffer()));
    return target;
  }

  async restoreState(): Promise<{ restored: number; objects: string[] }> {
    const revision = await this.revision();
    const states = [...await this.treeFiles("raw", revision)]
      .filter((objectName) => /^raw\/[^/]+\/state\.json\.gz$/u.test(objectName))
      .sort();
    await mapLimit(states, 8, async (objectName) => this.downloadObject(objectName, revision));
    return { restored: states.length, objects: states };
  }

  async latestCompleteRun(): Promise<{ revision: string; objectName: string; file: string; run: RawRunManifest }> {
    const revision = await this.revision();
    const runObjects = [...await this.treeFiles(RAW_RUN_ROOT, revision)]
      .filter((objectName) => objectName.endsWith(".json"))
      .sort()
      .reverse();
    for (const objectName of runObjects) {
      const file = await this.downloadObject(objectName, revision);
      if (!file) continue;
      const run = JSON.parse(await readFile(file, "utf8")) as RawRunManifest;
      if (run.complete === true) return { revision, objectName, file, run };
    }
    throw new Error("HF Raw has no complete Times run manifest");
  }

  async downloadLatestSnapshot(): Promise<Record<string, unknown>> {
    const latest = await this.latestCompleteRun();
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
      return { sourceId, dates: candidateDates(bytes), assets: candidateAssets(bytes) };
    });
    const rawAssets = new Set<string>();
    for (const bundle of bundles) for (const objectName of bundle.assets) rawAssets.add(objectName);
    await mapLimit([...rawAssets], 8, async (objectName) => this.downloadObject(objectName, latest.revision));
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
      rawFiles: 1 + rows.length * 2 + rawAssets.size,
      canonicalFiles: canonical.length,
    };
  }

  async uploadLocalFiles(files: Array<{ local: string; objectName: string }>, title: string): Promise<string | undefined> {
    if (files.length === 0) throw new Error("No files were selected for HF upload");
    const result = await uploadFiles({
      repo: this.repo,
      accessToken: this.accessToken,
      commitTitle: title,
      files: files.map((file) => ({ path: file.objectName, content: pathToFileURL(file.local) })),
      useWebWorkers: false,
      useXet: true,
    });
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
