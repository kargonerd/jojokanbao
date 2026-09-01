import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import {
  RUNTIME_FILE_HASH_CONCURRENCY,
  RUNTIME_MAX_ARCHIVE_PATH_BYTES,
  RUNTIME_MAX_ARCHIVE_PATH_DEPTH,
  RUNTIME_MAX_TAR_DECOMPRESSION_RATIO,
  RUNTIME_MAX_TAR_META_BYTES,
  assertRuntimeFileBudget,
  type RuntimeArchiveLimits,
  type RuntimeFileDigest,
  runtimeArchiveLimits,
  safeRuntimePath,
} from "./types.js";

export interface RuntimeArchiveEntry {
  path: string;
  size: number;
}

async function mapConcurrent<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: Array<U | undefined> = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      const value = values[index];
      if (value === undefined) throw new Error("Runtime file enumeration changed unexpectedly");
      results[index] = await mapper(value, index);
    }
  });
  await Promise.all(workers);
  return results.map((value, index) => {
    if (value === undefined) throw new Error(`Runtime file enumeration did not process entry ${index}`);
    return value;
  });
}

function archiveEntryPath(value: string, type: string, label: string): string {
  const withoutDot = value.replace(/^\.\//u, "");
  const normalized = type === "Directory" ? withoutDot.replace(/\/+$/u, "") : withoutDot;
  const entryPath = safeRuntimePath(normalized, `${label} entry`);
  if (Buffer.byteLength(entryPath, "utf8") > RUNTIME_MAX_ARCHIVE_PATH_BYTES) {
    throw new Error(`${label} entry path exceeds ${RUNTIME_MAX_ARCHIVE_PATH_BYTES} bytes`);
  }
  if (entryPath.split("/").length > RUNTIME_MAX_ARCHIVE_PATH_DEPTH) {
    throw new Error(`${label} entry path exceeds ${RUNTIME_MAX_ARCHIVE_PATH_DEPTH} components: ${entryPath}`);
  }
  return entryPath;
}

function regularArchiveEntry(type: string): boolean {
  return type === "File" || type === "OldFile" || type === "ContiguousFile";
}

export async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function walkFiles(root: string, directory: string, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`Runtime archives cannot contain symbolic links: ${entry.name}`);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walkFiles(root, absolute, files);
    else if (entry.isFile()) files.push(safeRuntimePath(path.relative(root, absolute).split(path.sep).join("/")));
    else throw new Error(`Runtime archives cannot contain special files: ${absolute}`);
  }
}

export async function describeFiles(
  rootValue: string,
  include: (relativePath: string) => boolean = () => true,
): Promise<RuntimeFileDigest[]> {
  const root = path.resolve(rootValue);
  const paths: string[] = [];
  await walkFiles(root, root, paths);
  const selected = paths.filter(include).sort((left, right) => left.localeCompare(right));
  return mapConcurrent(selected, RUNTIME_FILE_HASH_CONCURRENCY, async (relativePath) => {
    const file = path.join(root, ...relativePath.split("/"));
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Runtime archives can only contain regular files: ${relativePath}`);
    }
    if (metadata.nlink > 1) {
      throw new Error(`Runtime archives cannot contain hard-linked files: ${relativePath}`);
    }
    return { path: relativePath, size: metadata.size, sha256: await fileSha256(file) };
  });
}

export async function createArchive(
  rootValue: string,
  files: readonly RuntimeFileDigest[],
  archiveValue: string,
  gzip: boolean,
): Promise<{ file: string; size: number; sha256: string }> {
  if (files.length === 0) throw new Error("Runtime archive cannot be empty");
  const root = path.resolve(rootValue);
  const archive = path.resolve(archiveValue);
  const paths = files.map((entry) => archiveEntryPath(entry.path, "File", "Runtime archive manifest"));
  if (new Set(paths).size !== paths.length) throw new Error("Runtime archive contains duplicate paths");
  assertRuntimeFileBudget(files, "Runtime archive manifest");
  await mapConcurrent(files, RUNTIME_FILE_HASH_CONCURRENCY, async (entry) => {
    const file = path.join(root, ...entry.path.split("/"));
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Runtime archives can only contain regular files: ${entry.path}`);
    }
    if (metadata.nlink > 1) {
      throw new Error(`Runtime archives cannot contain hard-linked files: ${entry.path}`);
    }
    if (metadata.size !== entry.size) {
      throw new Error(`Runtime archive input size changed for ${entry.path}: expected ${entry.size}, got ${metadata.size}`);
    }
    return entry.path;
  });
  await mkdir(path.dirname(archive), { recursive: true });
  await tar.create({
    cwd: root,
    file: archive,
    gzip,
    portable: true,
    noMtime: true,
    strict: true,
  }, paths);
  const metadata = await stat(archive);
  return { file: archive, size: metadata.size, sha256: await fileSha256(archive) };
}

export async function inspectArchive(
  archiveValue: string,
  label = "Runtime archive",
  limitOverrides?: Partial<RuntimeArchiveLimits>,
): Promise<RuntimeArchiveEntry[]> {
  const archive = path.resolve(archiveValue);
  const limits = runtimeArchiveLimits(limitOverrides);
  const seen = new Set<string>();
  const files: RuntimeArchiveEntry[] = [];
  let entries = 0;
  let expandedBytes = 0;
  let validationError: Error | undefined;
  await tar.list({
    file: archive,
    strict: true,
    maxMetaEntrySize: RUNTIME_MAX_TAR_META_BYTES,
    maxDecompressionRatio: RUNTIME_MAX_TAR_DECOMPRESSION_RATIO,
    onentry(entry) {
      if (validationError) return;
      try {
        entries += 1;
        if (entries > limits.maxEntries) {
          throw new Error(`${label} has more than ${limits.maxEntries} entries`);
        }
        const entryPath = archiveEntryPath(entry.path, entry.type, label);
        if (seen.has(entryPath)) throw new Error(`${label} contains a duplicate entry: ${entryPath}`);
        seen.add(entryPath);
        if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
          throw new Error(`${label} entry has an invalid size: ${entryPath}`);
        }
        if (entry.type === "Directory") {
          if (entry.size !== 0) throw new Error(`${label} directory has a non-zero size: ${entryPath}`);
          return;
        }
        if (!regularArchiveEntry(entry.type)) {
          throw new Error(`${label} contains unsupported entry type ${entry.type}: ${entryPath}`);
        }
        if (entry.size > limits.maxEntryBytes) {
          throw new Error(`${label} entry exceeds ${limits.maxEntryBytes} bytes: ${entryPath}`);
        }
        if (entry.size > limits.maxExpandedBytes - expandedBytes) {
          throw new Error(`${label} expands beyond ${limits.maxExpandedBytes} bytes`);
        }
        expandedBytes += entry.size;
        files.push({ path: entryPath, size: entry.size });
      } catch (error) {
        validationError = error instanceof Error ? error : new Error(String(error));
      }
    },
  });
  if (validationError) throw validationError;
  return files;
}

export async function verifyArchive(
  archiveValue: string,
  expectedFiles: readonly RuntimeFileDigest[],
  limitOverrides?: Partial<RuntimeArchiveLimits>,
): Promise<void> {
  const limits = assertRuntimeFileBudget(expectedFiles, "Runtime archive manifest", limitOverrides);
  const expected = new Map(expectedFiles.map((entry) => [archiveEntryPath(entry.path, "File", "Runtime archive manifest"), entry]));
  if (expected.size !== expectedFiles.length) throw new Error("Runtime archive manifest contains duplicate paths");
  const actualFiles = await inspectArchive(archiveValue, "Runtime archive", limits);
  const seen = new Set<string>();
  for (const actual of actualFiles) {
    const expectedFile = expected.get(actual.path);
    if (!expectedFile) throw new Error(`Runtime archive contains an unexpected file: ${actual.path}`);
    if (actual.size !== expectedFile.size) {
      throw new Error(`Runtime archive declared size mismatch for ${actual.path}: expected ${expectedFile.size}, got ${actual.size}`);
    }
    seen.add(actual.path);
  }
  const missing = [...expected.keys()].filter((entry) => !seen.has(entry));
  if (missing.length) throw new Error(`Runtime archive is missing ${missing[0]}`);
}

export async function extractVerifiedArchive(
  archiveValue: string,
  outputValue: string,
  expectedFiles: readonly RuntimeFileDigest[],
  limitOverrides?: Partial<RuntimeArchiveLimits>,
): Promise<void> {
  const archive = path.resolve(archiveValue);
  const output = path.resolve(outputValue);
  const limits = assertRuntimeFileBudget(expectedFiles, "Runtime archive manifest", limitOverrides);
  await verifyArchive(archive, expectedFiles, limits);
  const temporary = await mkdtemp(path.join(tmpdir(), "jojo-times-runtime-"));
  try {
    const expected = new Set(expectedFiles.map((entry) => archiveEntryPath(entry.path, "File", "Runtime archive manifest")));
    const expectedDirectories = new Set<string>();
    for (const file of expected) {
      const parts = file.split("/");
      for (let index = 1; index < parts.length; index += 1) {
        expectedDirectories.add(parts.slice(0, index).join("/"));
      }
    }
    let entries = 0;
    let expandedBytes = 0;
    await tar.extract({
      cwd: temporary,
      file: archive,
      strict: true,
      preservePaths: false,
      maxDepth: RUNTIME_MAX_ARCHIVE_PATH_DEPTH,
      maxMetaEntrySize: RUNTIME_MAX_TAR_META_BYTES,
      maxDecompressionRatio: RUNTIME_MAX_TAR_DECOMPRESSION_RATIO,
      filter(entryPath, entry) {
        const readEntry = entry as { size: number; type: string };
        entries += 1;
        if (entries > limits.maxEntries) throw new Error(`Runtime archive has more than ${limits.maxEntries} entries`);
        const normalized = archiveEntryPath(entryPath, readEntry.type, "Runtime archive");
        if (readEntry.type === "Directory") return expectedDirectories.has(normalized);
        if (!regularArchiveEntry(readEntry.type) || !expected.has(normalized)) {
          throw new Error(`Runtime archive changed after verification: ${normalized}`);
        }
        if (!Number.isSafeInteger(readEntry.size) || readEntry.size < 0 || readEntry.size > limits.maxEntryBytes) {
          throw new Error(`Runtime archive entry has an invalid or excessive size: ${normalized}`);
        }
        if (readEntry.size > limits.maxExpandedBytes - expandedBytes) {
          throw new Error(`Runtime archive expands beyond ${limits.maxExpandedBytes} bytes`);
        }
        expandedBytes += readEntry.size;
        return true;
      },
    });
    const extracted = await describeFiles(temporary);
    if (extracted.length !== expectedFiles.length) throw new Error("Runtime archive extracted file count mismatch");
    const actualByPath = new Map(extracted.map((entry) => [entry.path, entry]));
    for (const expectedFile of expectedFiles) {
      const actual = actualByPath.get(expectedFile.path);
      if (!actual) throw new Error(`Runtime archive did not extract ${expectedFile.path}`);
      if (actual.size !== expectedFile.size) {
        throw new Error(`Runtime archive size mismatch for ${expectedFile.path}: expected ${expectedFile.size}, got ${actual.size}`);
      }
      if (actual.sha256 !== expectedFile.sha256) {
        throw new Error(`Runtime archive SHA-256 mismatch for ${expectedFile.path}`);
      }
    }
    for (const file of expectedFiles) {
      const source = path.join(temporary, ...file.path.split("/"));
      const target = path.join(output, ...file.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function readJsonFile<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}
