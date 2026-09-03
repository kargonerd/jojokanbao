import { gunzipSync } from "node:zlib";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createArchive, describeFiles, extractVerifiedArchive, fileSha256 } from "./archive.js";
import {
  PROCESS_MEMORY_OBJECT,
  parseProcessGenerationObjectName,
  parseRuntimeProcessGeneration,
  processGenerationObjectName,
  runtimeProcessGenerationObjects,
  type RuntimeFileDigest,
  type RuntimeJobStatus,
  type RuntimeObjectStore,
  type RuntimeProcessArchive,
  type RuntimeProcessGeneration,
  safeJobId,
  safeRuntimePath,
} from "./types.js";

const PROCESS_MANIFEST = "runtime/memory.json";
export const PROCESS_RESULT = "runtime/process-result.json";

interface ProcessGenerationManifest {
  formatVersion: "jojo-times-process-generation/1" | "jojo-times-process-generation/2";
  jobId: string;
  jobIds?: string[];
  createdAt: string;
  files: RuntimeFileDigest[];
  base?: RuntimeProcessArchive;
  stateFiles?: RuntimeFileDigest[];
  deltaDepth?: number;
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

function parseBatchJobIds(value: unknown, anchorJobId: string, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error(`${label} job ids are invalid`);
  }
  const jobIds = value.map((jobId) => safeJobId(jobId));
  if (jobIds[0] !== anchorJobId || new Set(jobIds).size !== jobIds.length) {
    throw new Error(`${label} job ids must be unique and start with the anchor job`);
  }
  return jobIds;
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
    generation: parseRuntimeProcessGeneration(row.generation, jobId),
  };
}

function retainedDate(value: string, cutoff: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) && value >= cutoff;
}

const MAX_PROCESS_DELTA_DEPTH = 12;
const MAX_PROCESS_DELTA_RATIO = 0.6;

function archiveDescriptor(generation: RuntimeProcessGeneration): RuntimeProcessArchive {
  return {
    objectName: generation.objectName,
    size: generation.size,
    sha256: generation.sha256,
    files: generation.files,
  };
}

function stateFilesFromFullArchive(archive: RuntimeProcessArchive): RuntimeFileDigest[] {
  return archive.files.filter((file) => file.path !== PROCESS_MANIFEST);
}

function sameFile(left: RuntimeFileDigest | undefined, right: RuntimeFileDigest): boolean {
  return left?.size === right.size && left.sha256 === right.sha256;
}

function totalBytes(files: readonly RuntimeFileDigest[]): number {
  return files.reduce((sum, file) => sum + file.size, 0);
}

function deltaPlan(
  previous: RuntimeProcessGeneration | undefined,
  stateFiles: readonly RuntimeFileDigest[],
): { base: RuntimeProcessArchive; files: RuntimeFileDigest[]; depth: number } | undefined {
  if (!previous) return undefined;
  const base = previous.base ?? archiveDescriptor(previous);
  const baseFiles = new Map(stateFilesFromFullArchive(base).map((file) => [file.path, file]));
  const files = stateFiles.filter((file) => file.path === PROCESS_RESULT || !sameFile(baseFiles.get(file.path), file));
  const depth = previous.base ? (previous.deltaDepth ?? MAX_PROCESS_DELTA_DEPTH) + 1 : 1;
  if (depth > MAX_PROCESS_DELTA_DEPTH) return undefined;
  if (totalBytes(files) > totalBytes(stateFiles) * MAX_PROCESS_DELTA_RATIO) return undefined;
  return { base, files, depth };
}

async function processGenerationFiles(output: string, now: Date, retentionDays: number): Promise<RuntimeFileDigest[]> {
  if (!Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 30) {
    throw new Error("Process memory retention must be an integer from 7 to 30 days");
  }
  const cutoffDate = new Date(now.valueOf() - retentionDays * 86_400_000).toISOString().slice(0, 10);
  const coreFiles = await describeFiles(output, (file) => {
    if (file === PROCESS_RESULT) return true;
    if (/^canonical\/[a-z0-9]+(?:-[a-z0-9]+)*\/dataset\.json$/u.test(file)) return true;
    const dateMatch = file.match(/^canonical\/[a-z0-9]+(?:-[a-z0-9]+)*\/dates\/\d{4}\/\d{2}\/(\d{4}-\d{2}-\d{2})\.json\.gz$/u);
    if (dateMatch?.[1] && retainedDate(dateMatch[1], cutoffDate)) return true;
    const translationMatch = file.match(/^canonical\/[a-z0-9]+(?:-[a-z0-9]+)*\/translations\/[^/]+\/\d{4}\/\d{2}\/(\d{4}-\d{2}-\d{2})\/[a-f0-9]{64}\.json\.gz$/u);
    return Boolean(translationMatch?.[1] && retainedDate(translationMatch[1], cutoffDate));
  });
  if (!coreFiles.some((file) => file.path === PROCESS_RESULT)) {
    throw new Error(`Process result is missing: ${PROCESS_RESULT}`);
  }
  const dateIndexes = coreFiles
    .map((file) => file.path)
    .filter((file) => /^canonical\/[a-z0-9]+(?:-[a-z0-9]+)*\/dates\//u.test(file));
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
      articleObjects.add(objectName);
    }
  }
  const assetObjects = new Set<string>();
  for (const articleObject of articleObjects) {
    const article = JSON.parse(gunzipSync(await readFile(path.join(output, ...articleObject.split("/")))).toString("utf8")) as { assets?: unknown };
    if (!Array.isArray(article.assets)) throw new Error(`Canonical article has invalid assets: ${articleObject}`);
    for (const assetValue of article.assets) {
      if (!assetValue || typeof assetValue !== "object" || Array.isArray(assetValue)) continue;
      const rawObject = safeRuntimePath((assetValue as { rawObject?: unknown }).rawObject, `Canonical asset in ${articleObject}`);
      if (!/^raw\/[a-z0-9]+(?:-[a-z0-9]+)*\/assets\/[A-Za-z0-9._/-]+$/u.test(rawObject)) {
        throw new Error(`Canonical article has unsafe asset reference: ${rawObject}`);
      }
      assetObjects.add(rawObject);
    }
  }
  const referencedPaths = new Set([...articleObjects, ...assetObjects]);
  const referencedFiles = await describeFiles(output, (file) => referencedPaths.has(file));
  const foundPaths = new Set(referencedFiles.map((file) => file.path));
  const missingArticle = [...articleObjects].find((file) => !foundPaths.has(file));
  if (missingArticle) throw new Error(`Canonical date index references a missing article: ${missingArticle}`);
  const missingAsset = [...assetObjects].find((file) => !foundPaths.has(file));
  if (missingAsset) throw new Error(`Canonical article references a missing asset: ${missingAsset}`);
  return [...coreFiles, ...referencedFiles].sort((left, right) => left.path.localeCompare(right.path));
}

async function restoreGeneration(options: {
  store: RuntimeObjectStore;
  output: string;
  workDirectory: string;
  jobId: string;
  generation: RuntimeProcessGeneration;
}): Promise<string[]> {
  const generation = parseRuntimeProcessGeneration(options.generation, options.jobId);
  const restoreArchive = async (descriptor: RuntimeProcessArchive, label: string): Promise<void> => {
    const archive = path.resolve(options.workDirectory, `${options.jobId}.${label}-download.tar.gz`);
    if (!await options.store.download(descriptor.objectName, archive, { maxBytes: descriptor.size })) {
      throw new Error(`Process generation is missing: ${descriptor.objectName}`);
    }
    const digest = await fileSha256(archive);
    if (digest !== descriptor.sha256) throw new Error(`Process ${label} generation SHA-256 mismatch`);
    await extractVerifiedArchive(archive, options.output, descriptor.files);
  };

  if (generation.base) await restoreArchive(generation.base, "base");
  await restoreArchive(generation, generation.base ? "delta" : "full");

  if (generation.base && generation.stateFiles) {
    const effectivePaths = new Set(generation.stateFiles.map((file) => file.path));
    const archivedPaths = new Set([...generation.base.files, ...generation.files].map((file) => file.path));
    for (const archivedPath of archivedPaths) {
      if (archivedPath !== PROCESS_MANIFEST && !effectivePaths.has(archivedPath)) {
        await rm(path.join(options.output, ...archivedPath.split("/")), { force: true });
      }
    }
    const restoredFiles = await describeFiles(options.output, (file) => effectivePaths.has(file));
    const restoredByPath = new Map(restoredFiles.map((file) => [file.path, file]));
    for (const expected of generation.stateFiles) {
      const actual = restoredByPath.get(expected.path);
      if (!actual || actual.size !== expected.size || actual.sha256 !== expected.sha256) {
        throw new Error(`Process delta restore did not reproduce effective state: ${expected.path}`);
      }
    }
  }

  const manifestValue = JSON.parse(await readFile(path.join(options.output, ...PROCESS_MANIFEST.split("/")), "utf8")) as unknown;
  if (!manifestValue || typeof manifestValue !== "object" || Array.isArray(manifestValue)) {
    throw new Error("Process generation manifest is invalid");
  }
  const manifest = manifestValue as Record<string, unknown>;
  const expectedFormat = generation.base ? "jojo-times-process-generation/2" : "jojo-times-process-generation/1";
  if (manifest.formatVersion !== expectedFormat || safeJobId(manifest.jobId) !== options.jobId) {
    throw new Error("Process generation manifest does not match the selected job");
  }
  if (generation.base && (
    JSON.stringify(manifest.base) !== JSON.stringify(generation.base)
    || JSON.stringify(manifest.stateFiles) !== JSON.stringify(generation.stateFiles)
    || manifest.deltaDepth !== generation.deltaDepth
  )) {
    throw new Error("Process delta manifest does not match its generation descriptor");
  }
  const generationJobIds = generation.jobIds ?? [options.jobId];
  const manifestJobIds = manifest.jobIds === undefined
    ? [options.jobId]
    : parseBatchJobIds(manifest.jobIds, options.jobId, "Process generation manifest");
  if (JSON.stringify(manifestJobIds) !== JSON.stringify(generationJobIds)) {
    throw new Error("Process generation manifest does not match its batch jobs");
  }
  return generationJobIds;
}

export async function stageRuntimeProcess(options: {
  store: RuntimeObjectStore;
  output: string;
  workDirectory: string;
  status: RuntimeJobStatus;
  jobIds?: readonly string[];
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
  const jobIds = (options.jobIds ?? [options.status.jobId]).map((jobId) => safeJobId(jobId));
  if (jobIds.length === 0 || jobIds.length > 20 || jobIds[0] !== options.status.jobId || new Set(jobIds).size !== jobIds.length) {
    throw new Error("Process batch job ids must be unique and start with the anchor job");
  }
  const stateFiles = await processGenerationFiles(output, now, options.retentionDays ?? 8);
  const previous = await committedRuntimeProcessGeneration(options.store);
  const delta = deltaPlan(previous?.generation, stateFiles);
  const files = delta?.files ?? stateFiles;
  const manifest: ProcessGenerationManifest = {
    formatVersion: delta ? "jojo-times-process-generation/2" : "jojo-times-process-generation/1",
    jobId: options.status.jobId,
    jobIds,
    createdAt: now.toISOString(),
    files,
    ...(delta ? { base: delta.base, stateFiles, deltaDepth: delta.depth } : {}),
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
        jobIds,
        ...(delta ? { base: delta.base, stateFiles, deltaDepth: delta.depth } : {}),
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
}): Promise<{ restored: boolean; replay: boolean; basedOnJobId?: string; jobIds?: string[]; generatedAt?: string; processResultFile?: string }> {
  if (options.status.stagedProcess) {
    const jobIds = await restoreGeneration({ ...options, jobId: options.status.jobId, generation: options.status.stagedProcess });
    return {
      restored: true,
      replay: true,
      basedOnJobId: options.status.jobId,
      jobIds,
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
  if (previous) {
    const retained = new Set(runtimeProcessGenerationObjects(pointer.generation));
    const obsolete = runtimeProcessGenerationObjects(previous.generation)
      .filter((objectName) => !retained.has(objectName));
    if (obsolete.length) await options.store.delete(obsolete);
  }
}
