import { gunzipSync } from "node:zlib";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { createArchive, describeFiles, inspectArchive } from "./archive.js";
import {
  CAPTURE_MEMORY_OBJECT,
  PROCESS_MEMORY_OBJECT,
  RUNTIME_MAX_ARCHIVE_PATH_DEPTH,
  RUNTIME_MAX_TAR_DECOMPRESSION_RATIO,
  RUNTIME_MAX_TAR_META_BYTES,
  RUNTIME_MAX_TEXT_BYTES,
  assertRuntimeFileBudget,
  type RuntimeArchiveLimits,
  type RuntimeFileDigest,
  type RuntimeObjectStore,
  safeJobId,
  safeRuntimePath,
} from "./types.js";

export type RuntimeMemoryKind = "capture" | "process";

interface RuntimeMemoryManifest {
  formatVersion: "jojo-times-memory/1";
  kind: RuntimeMemoryKind;
  createdAt: string;
  basedOnJobId: string;
  files: RuntimeFileDigest[];
}

const MEMORY_MANIFEST = "runtime/memory.json";

function memoryObject(kind: RuntimeMemoryKind): string {
  return kind === "capture" ? CAPTURE_MEMORY_OBJECT : PROCESS_MEMORY_OBJECT;
}

function parseMemoryManifest(value: unknown, expectedKind: RuntimeMemoryKind): RuntimeMemoryManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Runtime memory manifest is invalid");
  const input = value as Record<string, unknown>;
  if (input.formatVersion !== "jojo-times-memory/1" || input.kind !== expectedKind) {
    throw new Error(`Runtime ${expectedKind} memory has the wrong format or kind`);
  }
  if (typeof input.createdAt !== "string" || Number.isNaN(Date.parse(input.createdAt))) {
    throw new Error(`Runtime ${expectedKind} memory has an invalid timestamp`);
  }
  const basedOnJobId = safeJobId(input.basedOnJobId);
  if (!Array.isArray(input.files) || input.files.length === 0) {
    throw new Error(`Runtime ${expectedKind} memory has no files`);
  }
  const seen = new Set<string>();
  const files = input.files.map((value, index): RuntimeFileDigest => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Runtime memory file ${index} is invalid`);
    const file = value as Record<string, unknown>;
    const filePath = safeRuntimePath(file.path, `Runtime memory file ${index}`);
    if (filePath === MEMORY_MANIFEST || seen.has(filePath)) throw new Error(`Invalid or duplicate Runtime memory file: ${filePath}`);
    seen.add(filePath);
    if (!Number.isSafeInteger(file.size) || (file.size as number) < 0) throw new Error(`Runtime memory file ${filePath} has invalid size`);
    if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(file.sha256)) {
      throw new Error(`Runtime memory file ${filePath} has invalid SHA-256`);
    }
    return { path: filePath, size: file.size as number, sha256: file.sha256 };
  });
  assertRuntimeFileBudget(files, `Runtime ${expectedKind} memory manifest`);
  return {
    formatVersion: "jojo-times-memory/1",
    kind: expectedKind,
    createdAt: input.createdAt,
    basedOnJobId,
    files,
  };
}

function captureMemoryPath(relativePath: string): boolean {
  return /^raw\/[a-z0-9]+(?:-[a-z0-9]+)*\/state\.json\.gz$/u.test(relativePath);
}

function retainedDate(value: string, cutoff: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) && value >= cutoff;
}

async function processMemoryFiles(output: string, now: Date, retentionDays: number): Promise<RuntimeFileDigest[]> {
  if (!Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 30) {
    throw new Error("Process memory retention must be an integer from 7 to 30 days");
  }
  const cutoffDate = new Date(now.valueOf() - retentionDays * 86_400_000).toISOString().slice(0, 10);
  const all = await describeFiles(output);
  const byPath = new Map(all.map((file) => [file.path, file]));
  const selected = new Set<string>();
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
  const articleObjects = new Set<string>();
  for (const indexObject of dateIndexes) {
    const index = JSON.parse(gunzipSync(await readFile(path.join(output, ...indexObject.split("/")))).toString("utf8")) as {
      articles?: unknown;
    };
    if (!Array.isArray(index.articles)) throw new Error(`Canonical date index has invalid articles: ${indexObject}`);
    for (const articleValue of index.articles) {
      if (!articleValue || typeof articleValue !== "object" || Array.isArray(articleValue)) continue;
      const objectName = (articleValue as { object?: unknown }).object;
      const safe = safeRuntimePath(objectName, `Canonical article reference in ${indexObject}`);
      if (!/^canonical\/[a-z0-9]+(?:-[a-z0-9]+)*\/articles\/[a-f0-9]{64}\.json\.gz$/u.test(safe)) {
        throw new Error(`Canonical date index has unsafe article reference: ${safe}`);
      }
      if (!byPath.has(safe)) throw new Error(`Canonical date index references a missing article: ${safe}`);
      articleObjects.add(safe);
      selected.add(safe);
    }
  }
  for (const articleObject of articleObjects) {
    const article = JSON.parse(gunzipSync(await readFile(path.join(output, ...articleObject.split("/")))).toString("utf8")) as {
      assets?: unknown;
    };
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
  return [...selected].sort((left, right) => left.localeCompare(right)).map((objectName) => byPath.get(objectName)!);
}

export async function publishRuntimeMemory(options: {
  store: RuntimeObjectStore;
  output: string;
  workDirectory: string;
  kind: RuntimeMemoryKind;
  basedOnJobId: string;
  now?: Date;
  processRetentionDays?: number;
}): Promise<{ objectName: string; files: number; size: number; skipped?: boolean }> {
  const output = path.resolve(options.output);
  const now = options.now ?? new Date();
  const files = options.kind === "capture"
    ? await describeFiles(output, captureMemoryPath)
    : await processMemoryFiles(output, now, options.processRetentionDays ?? 8);
  if (files.length === 0) return { objectName: memoryObject(options.kind), files: 0, size: 0, skipped: true };
  const manifest: RuntimeMemoryManifest = {
    formatVersion: "jojo-times-memory/1",
    kind: options.kind,
    createdAt: now.toISOString(),
    basedOnJobId: safeJobId(options.basedOnJobId),
    files,
  };
  const manifestFile = path.join(output, ...MEMORY_MANIFEST.split("/"));
  await mkdir(path.dirname(manifestFile), { recursive: true });
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    const manifestDigest = (await describeFiles(output, (relativePath) => relativePath === MEMORY_MANIFEST))[0];
    if (!manifestDigest) throw new Error("Runtime memory manifest was not written");
    const archiveFile = path.resolve(options.workDirectory, `${options.kind}-memory.tar.gz`);
    const archive = await createArchive(output, [...files, manifestDigest], archiveFile, true);
    const objectName = memoryObject(options.kind);
    await options.store.upload(objectName, archive.file);
    return { objectName, files: files.length, size: archive.size };
  } finally {
    await rm(path.join(output, "runtime"), { recursive: true, force: true });
  }
}

export async function restoreRuntimeMemory(options: {
  store: RuntimeObjectStore;
  output: string;
  workDirectory: string;
  kind: RuntimeMemoryKind;
  archiveLimits?: Partial<RuntimeArchiveLimits>;
}): Promise<{ restored: boolean; basedOnJobId?: string; files: number }> {
  const archive = path.resolve(options.workDirectory, `${options.kind}-memory-download.tar.gz`);
  if (!await options.store.download(memoryObject(options.kind), archive)) return { restored: false, files: 0 };
  const temporary = await mkdtemp(path.join(tmpdir(), `jojo-times-${options.kind}-memory-`));
  try {
    const inspected = await inspectArchive(archive, `Runtime ${options.kind} memory archive`, options.archiveLimits);
    const seen = new Set(inspected.map((entry) => entry.path));
    if (!seen.has(MEMORY_MANIFEST)) throw new Error("Runtime memory archive has no manifest");
    const manifestEntry = inspected.find((entry) => entry.path === MEMORY_MANIFEST)!;
    if (manifestEntry.size > RUNTIME_MAX_TEXT_BYTES) {
      throw new Error(`Runtime memory manifest exceeds ${RUNTIME_MAX_TEXT_BYTES} bytes`);
    }
    const expectedDirectories = new Set<string>();
    for (const file of seen) {
      const parts = file.split("/");
      for (let index = 1; index < parts.length; index += 1) {
        expectedDirectories.add(parts.slice(0, index).join("/"));
      }
    }
    await tar.extract({
      cwd: temporary,
      file: archive,
      strict: true,
      preservePaths: false,
      maxDepth: RUNTIME_MAX_ARCHIVE_PATH_DEPTH,
      maxMetaEntrySize: RUNTIME_MAX_TAR_META_BYTES,
      maxDecompressionRatio: RUNTIME_MAX_TAR_DECOMPRESSION_RATIO,
      filter(entryPath, entry) {
        const readEntry = entry as { type: string };
        const rawPath = entryPath.replace(/^\.\//u, "");
        const normalized = safeRuntimePath(
          readEntry.type === "Directory" ? rawPath.replace(/\/+$/u, "") : rawPath,
          "Runtime memory archive entry",
        );
        if (readEntry.type === "Directory") return expectedDirectories.has(normalized);
        if (readEntry.type !== "File" && readEntry.type !== "OldFile" && readEntry.type !== "ContiguousFile") {
          throw new Error(`Runtime memory changed to unsupported entry type ${readEntry.type}: ${normalized}`);
        }
        if (!seen.has(normalized)) throw new Error(`Runtime memory changed after verification: ${normalized}`);
        return true;
      },
    });
    const manifest = parseMemoryManifest(
      JSON.parse(await readFile(path.join(temporary, ...MEMORY_MANIFEST.split("/")), "utf8")) as unknown,
      options.kind,
    );
    const actual = await describeFiles(temporary, (relativePath) => relativePath !== MEMORY_MANIFEST);
    const expectedByPath = new Map(manifest.files.map((file) => [file.path, file]));
    if (actual.length !== manifest.files.length) throw new Error("Runtime memory file count mismatch");
    for (const file of actual) {
      const expected = expectedByPath.get(file.path);
      if (!expected || expected.size !== file.size || expected.sha256 !== file.sha256) {
        throw new Error(`Runtime memory verification failed for ${file.path}`);
      }
      const allowed = options.kind === "capture"
        ? captureMemoryPath(file.path)
        : file.path.startsWith("canonical/") || /^raw\/[a-z0-9]+(?:-[a-z0-9]+)*\/assets\//u.test(file.path);
      if (!allowed) throw new Error(`Runtime ${options.kind} memory contains an out-of-scope file: ${file.path}`);
    }
    const output = path.resolve(options.output);
    for (const file of actual) {
      const source = path.join(temporary, ...file.path.split("/"));
      const target = path.join(output, ...file.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    return { restored: true, basedOnJobId: manifest.basedOnJobId, files: actual.length };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
