import { gunzipSync } from "node:zlib";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createArchive, describeFiles, extractVerifiedArchive, fileSha256 } from "./archive.js";
import {
  PROCESS_MEMORY_OBJECT,
  RUNTIME_MAX_DOWNLOAD_BYTES,
  assertRuntimeFileBudget,
  parseProcessGenerationObjectName,
  processGenerationObjectName,
  type RuntimeFileDigest,
  type RuntimeJobStatus,
  type RuntimeObjectStore,
  type RuntimeProcessGeneration,
  safeJobId,
  safeRuntimePath,
} from "./types.js";

const PROCESS_MANIFEST = "runtime/memory.json";
export const PROCESS_RESULT = "runtime/process-result.json";

interface ProcessGenerationManifest {
  formatVersion: "jojo-times-process-generation/1";
  jobId: string;
  createdAt: string;
  files: RuntimeFileDigest[];
}

export interface ProcessMemoryPointer {
  formatVersion: "jojo-times-process-memory/1";
  updatedAt: string;
  jobId: string;
  generation: RuntimeProcessGeneration;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`Invalid ${label}`);
  return value;
}

function parseFiles(value: unknown, label: string): RuntimeFileDigest[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} has no files`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${label} file ${index} is invalid`);
    const row = entry as Record<string, unknown>;
    const filePath = safeRuntimePath(row.path, `${label} file ${index}`);
    if (seen.has(filePath)) throw new Error(`${label} contains duplicate file ${filePath}`);
    seen.add(filePath);
    if (!Number.isSafeInteger(row.size) || (row.size as number) < 0) throw new Error(`${label} file size is invalid`);
    if (typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.sha256)) throw new Error(`${label} file SHA-256 is invalid`);
    return { path: filePath, size: row.size as number, sha256: row.sha256 };
  });
}

function parseGeneration(value: unknown, expectedJobId?: string): RuntimeProcessGeneration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Process generation is invalid");
  const row = value as Record<string, unknown>;
  const parsedObject = parseProcessGenerationObjectName(row.objectName);
  const { objectName, jobId } = parsedObject;
  if (expectedJobId && jobId !== safeJobId(expectedJobId)) throw new Error("Process generation belongs to a different job");
  if (!Number.isSafeInteger(row.size) || (row.size as number) <= 0) throw new Error("Process generation size is invalid");
  if ((row.size as number) > RUNTIME_MAX_DOWNLOAD_BYTES) throw new Error("Process generation exceeds the Runtime download limit");
  if (typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.sha256)) throw new Error("Process generation SHA-256 is invalid");
  if (parsedObject.sha256 !== row.sha256) throw new Error("Process generation object does not match its SHA-256");
  const files = parseFiles(row.files, "Process generation");
  assertRuntimeFileBudget(files, "Process generation manifest");
  if (!files.some((file) => file.path === PROCESS_RESULT) || !files.some((file) => file.path === PROCESS_MANIFEST)) {
    throw new Error("Process generation is missing its result or manifest");
  }
  return {
    objectName,
    createdAt: timestamp(row.createdAt, "Process generation createdAt"),
    size: row.size as number,
    sha256: row.sha256,
    files,
  };
}

function parsePointer(value: unknown): ProcessMemoryPointer {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Process memory pointer is invalid");
  const row = value as Record<string, unknown>;
  if (row.formatVersion !== "jojo-times-process-memory/1") throw new Error("Process memory pointer has an unsupported format");
  const jobId = safeJobId(row.jobId);
  return {
    formatVersion: "jojo-times-process-memory/1",
    updatedAt: timestamp(row.updatedAt, "Process memory pointer updatedAt"),
    jobId,
    generation: parseGeneration(row.generation, jobId),
  };
}

function retainedDate(value: string, cutoff: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) && value >= cutoff;
}

async function processGenerationFiles(output: string, now: Date, retentionDays: number): Promise<RuntimeFileDigest[]> {
  if (!Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 30) {
    throw new Error("Process memory retention must be an integer from 7 to 30 days");
  }
  const cutoffDate = new Date(now.valueOf() - retentionDays * 86_400_000).toISOString().slice(0, 10);
  const all = await describeFiles(output);
  const byPath = new Map(all.map((file) => [file.path, file]));
  const selected = new Set<string>([PROCESS_RESULT]);
  const dateIndexes: string[] = [];
  for (const file of all) {
    if (/^canonical\/[a-z0-9]+(?:-[a-z0-9]+)*\/dataset\.json$/u.test(file.path)) selected.add(file.path);
    const dateMatch = file.path.match(/^canonical\/[a-z0-9]+(?:-[a-z0-9]+)*\/dates\/\d{4}\/\d{2}\/(\d{4}-\d{2}-\d{2})\.json\.gz$/u);
    if (dateMatch?.[1] && retainedDate(dateMatch[1], cutoffDate)) {
      selected.add(file.path);
      dateIndexes.push(file.path);
    }
    const translationMatch = file.path.match(/^canonical\/[a-z0-9]+(?:-[a-z0-9]+)*\/translations\/[^/]+\/\d{4}\/\d{2}\/(\d{4}-\d{2}-\d{2})\/[a-f0-9]{64}\.json\.gz$/u);
    if (translationMatch?.[1] && retainedDate(translationMatch[1], cutoffDate)) selected.add(file.path);
  }
  if (!byPath.has(PROCESS_RESULT)) throw new Error(`Process result is missing: ${PROCESS_RESULT}`);
  const articleObjects = new Set<string>();
  for (const indexObject of dateIndexes) {
    const index = JSON.parse(gunzipSync(await readFile(path.join(output, ...indexObject.split("/")))).toString("utf8")) as { articles?: unknown };
    if (!Array.isArray(index.articles)) throw new Error(`Canonical date index has invalid articles: ${indexObject}`);
    for (const articleValue of index.articles) {
      if (!articleValue || typeof articleValue !== "object" || Array.isArray(articleValue)) continue;
      const objectName = safeRuntimePath((articleValue as { object?: unknown }).object, `Canonical article reference in ${indexObject}`);
      if (!/^canonical\/[a-z0-9]+(?:-[a-z0-9]+)*\/articles\/[a-f0-9]{64}\.json\.gz$/u.test(objectName)) {
        throw new Error(`Canonical date index has unsafe article reference: ${objectName}`);
      }
      if (!byPath.has(objectName)) throw new Error(`Canonical date index references a missing article: ${objectName}`);
      articleObjects.add(objectName);
      selected.add(objectName);
    }
  }
  for (const articleObject of articleObjects) {
    const article = JSON.parse(gunzipSync(await readFile(path.join(output, ...articleObject.split("/")))).toString("utf8")) as { assets?: unknown };
    if (!Array.isArray(article.assets)) throw new Error(`Canonical article has invalid assets: ${articleObject}`);
    for (const assetValue of article.assets) {
      if (!assetValue || typeof assetValue !== "object" || Array.isArray(assetValue)) continue;
      const rawObject = safeRuntimePath((assetValue as { rawObject?: unknown }).rawObject, `Canonical asset in ${articleObject}`);
      if (!/^raw\/[a-z0-9]+(?:-[a-z0-9]+)*\/assets\/[A-Za-z0-9._/-]+$/u.test(rawObject)) {
        throw new Error(`Canonical article has unsafe asset reference: ${rawObject}`);
      }
      if (!byPath.has(rawObject)) throw new Error(`Canonical article references a missing asset: ${rawObject}`);
      selected.add(rawObject);
    }
  }
  return [...selected].sort().map((objectName) => byPath.get(objectName)!);
}

async function restoreGeneration(options: {
  store: RuntimeObjectStore;
  output: string;
  workDirectory: string;
  jobId: string;
  generation: RuntimeProcessGeneration;
}): Promise<void> {
  const generation = parseGeneration(options.generation, options.jobId);
  const archive = path.resolve(options.workDirectory, `${options.jobId}.processed-download.tar.gz`);
  if (!await options.store.download(generation.objectName, archive, { maxBytes: generation.size })) {
    throw new Error(`Process generation is missing: ${generation.objectName}`);
  }
  const digest = await fileSha256(archive);
  if (digest !== generation.sha256) throw new Error("Process generation SHA-256 mismatch");
  await extractVerifiedArchive(archive, options.output, generation.files);
  const manifest = JSON.parse(await readFile(path.join(options.output, ...PROCESS_MANIFEST.split("/")), "utf8")) as ProcessGenerationManifest;
  if (manifest.formatVersion !== "jojo-times-process-generation/1" || safeJobId(manifest.jobId) !== options.jobId) {
    throw new Error("Process generation manifest does not match the selected job");
  }
}

export async function stageRuntimeProcess(options: {
  store: RuntimeObjectStore;
  output: string;
  workDirectory: string;
  status: RuntimeJobStatus;
  processResultFile: string;
  retentionDays?: number;
  now?: Date;
}): Promise<RuntimeJobStatus> {
  if (options.status.stagedProcess) return options.status;
  const output = path.resolve(options.output);
  const resultTarget = path.join(output, ...PROCESS_RESULT.split("/"));
  await mkdir(path.dirname(resultTarget), { recursive: true });
  await copyFile(path.resolve(options.processResultFile), resultTarget);
  const now = options.now ?? new Date();
  const files = await processGenerationFiles(output, now, options.retentionDays ?? 8);
  const manifest: ProcessGenerationManifest = {
    formatVersion: "jojo-times-process-generation/1",
    jobId: options.status.jobId,
    createdAt: now.toISOString(),
    files,
  };
  const manifestFile = path.join(output, ...PROCESS_MANIFEST.split("/"));
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    const manifestDigest = (await describeFiles(output, (file) => file === PROCESS_MANIFEST))[0];
    if (!manifestDigest) throw new Error("Process generation manifest was not written");
    const archiveFiles = [...files, manifestDigest].sort((left, right) => left.path.localeCompare(right.path));
    const archive = await createArchive(
      output,
      archiveFiles,
      path.resolve(options.workDirectory, `${options.status.jobId}.processed.tar.gz`),
      true,
    );
    const objectName = processGenerationObjectName(options.status.jobId, archive.sha256);
    const existing = await options.store.info(objectName);
    if (existing) {
      let exact = false;
      if (existing.size === archive.size) {
        const downloaded = path.resolve(options.workDirectory, `${options.status.jobId}.processed-existing.tar.gz`);
        exact = await options.store.download(objectName, downloaded, { maxBytes: archive.size })
          && await fileSha256(downloaded) === archive.sha256;
      }
      if (!exact) {
        throw new Error(`Immutable Process generation already exists with different bytes: ${objectName}`);
      }
    } else {
      await options.store.upload(objectName, archive.file);
    }
    return {
      ...options.status,
      updatedAt: now.toISOString(),
      stagedProcess: {
        objectName,
        createdAt: now.toISOString(),
        size: archive.size,
        sha256: archive.sha256,
        files: archiveFiles,
      },
    };
  } finally {
    await rm(manifestFile, { force: true });
  }
}

export async function restoreRuntimeProcess(options: {
  store: RuntimeObjectStore;
  output: string;
  workDirectory: string;
  status: RuntimeJobStatus;
}): Promise<{ restored: boolean; replay: boolean; basedOnJobId?: string; generatedAt?: string; processResultFile?: string }> {
  if (options.status.stagedProcess) {
    await restoreGeneration({ ...options, jobId: options.status.jobId, generation: options.status.stagedProcess });
    return {
      restored: true,
      replay: true,
      basedOnJobId: options.status.jobId,
      generatedAt: options.status.stagedProcess.createdAt,
      processResultFile: path.join(path.resolve(options.output), ...PROCESS_RESULT.split("/")),
    };
  }
  const pointer = await committedRuntimeProcessGeneration(options.store);
  if (!pointer) return { restored: false, replay: false };
  await restoreGeneration({ ...options, jobId: pointer.jobId, generation: pointer.generation });
  return { restored: true, replay: false, basedOnJobId: pointer.jobId };
}

export async function committedRuntimeProcessGeneration(
  store: RuntimeObjectStore,
): Promise<ProcessMemoryPointer | null> {
  const body = await store.readText(PROCESS_MEMORY_OBJECT);
  return body === null ? null : parsePointer(JSON.parse(body) as unknown);
}

export async function assertRuntimeProcessGenerationUncommitted(
  store: RuntimeObjectStore,
  objectNameValue: unknown,
): Promise<void> {
  const objectName = parseProcessGenerationObjectName(objectNameValue).objectName;
  const pointer = await committedRuntimeProcessGeneration(store);
  if (pointer?.generation.objectName === objectName) {
    throw new Error(`Refusing to discard the committed Process generation: ${objectName}`);
  }
}

export async function promoteRuntimeProcess(options: {
  store: RuntimeObjectStore;
  status: RuntimeJobStatus;
  workDirectory: string;
  now?: Date;
}): Promise<void> {
  if (!options.status.stagedProcess) throw new Error(`Runtime job has no staged Process generation: ${options.status.jobId}`);
  const previous = await committedRuntimeProcessGeneration(options.store);
  const pointer: ProcessMemoryPointer = {
    formatVersion: "jojo-times-process-memory/1",
    updatedAt: (options.now ?? new Date()).toISOString(),
    jobId: options.status.jobId,
    generation: options.status.stagedProcess,
  };
  const pointerFile = path.resolve(options.workDirectory, `${options.status.jobId}.process-memory.json`);
  await mkdir(path.dirname(pointerFile), { recursive: true });
  await writeFile(pointerFile, `${JSON.stringify(pointer, null, 2)}\n`);
  await options.store.upload(PROCESS_MEMORY_OBJECT, pointerFile);
  if (previous && previous.generation.objectName !== pointer.generation.objectName) {
    await options.store.delete([previous.generation.objectName]);
  }
}
