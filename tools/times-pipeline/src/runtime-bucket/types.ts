export const RUNTIME_PREFIX = "times";
export const CAPTURE_MEMORY_OBJECT = `${RUNTIME_PREFIX}/capture-memory.tar.gz`;
export const PROCESS_MEMORY_OBJECT = `${RUNTIME_PREFIX}/process-memory.json`;
export const PENDING_JOBS_OBJECT = `${RUNTIME_PREFIX}/pending-jobs.json`;
export const PENDING_JOB_PREFIX = `${RUNTIME_PREFIX}/pending`;

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Hard ceilings for untrusted Runtime Bucket payloads. Callers may only lower them. */
export const RUNTIME_MAX_DOWNLOAD_BYTES = 5 * GIB;
export const RUNTIME_MAX_TEXT_BYTES = 32 * MIB;
export const RUNTIME_MAX_ARCHIVE_ENTRIES = 100_000;
export const RUNTIME_MAX_ARCHIVE_ENTRY_BYTES = 64 * MIB;
export const RUNTIME_MAX_ARCHIVE_EXPANDED_BYTES = 4 * GIB;
export const RUNTIME_MAX_ARCHIVE_PATH_BYTES = 2 * 1024;
export const RUNTIME_MAX_ARCHIVE_PATH_DEPTH = 32;
export const RUNTIME_MAX_TAR_META_BYTES = 1 * MIB;
export const RUNTIME_MAX_TAR_DECOMPRESSION_RATIO = 100;
export const RUNTIME_FILE_HASH_CONCURRENCY = 8;

export interface RuntimeReadOptions {
  /** Optional tighter limit; values above the hard ceiling are rejected. */
  maxBytes?: number;
}

export interface RuntimeArchiveLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxExpandedBytes: number;
}

export const RUNTIME_ARCHIVE_LIMITS: Readonly<RuntimeArchiveLimits> = Object.freeze({
  maxEntries: RUNTIME_MAX_ARCHIVE_ENTRIES,
  maxEntryBytes: RUNTIME_MAX_ARCHIVE_ENTRY_BYTES,
  maxExpandedBytes: RUNTIME_MAX_ARCHIVE_EXPANDED_BYTES,
});

export type RuntimeJobState = "ready" | "partial" | "done";

export interface RuntimeFileDigest {
  path: string;
  size: number;
  sha256: string;
}

export interface RuntimeJobArticle {
  sourceId: string;
  articleId: string;
}

export interface RuntimeJobFailure extends RuntimeJobArticle {
  reason: string;
}

export interface RuntimeProcessArchive {
  objectName: string;
  size: number;
  sha256: string;
  files: RuntimeFileDigest[];
}

export interface RuntimeProcessGeneration extends RuntimeProcessArchive {
  createdAt: string;
  /** Ordered Runtime jobs committed by this generation. Absent on legacy single-job generations. */
  jobIds?: string[];
  /**
   * A full immutable generation reused as the base for a cumulative delta.
   * Delta generations always restore from exactly two archives: base + delta.
   */
  base?: RuntimeProcessArchive;
  /** Effective Process state after applying the delta, excluding the synthetic memory manifest. */
  stateFiles?: RuntimeFileDigest[];
  /** Number of generations accumulated against `base` before the next full compaction. */
  deltaDepth?: number;
}

export interface RuntimeJobStatus {
  formatVersion: "jojo-times-job/1";
  jobId: string;
  runId: string;
  runManifest: string;
  createdAt: string;
  updatedAt: string;
  state: RuntimeJobState;
  attempts: number;
  raw: {
    objectName: string;
    size: number;
    sha256: string;
    files: RuntimeFileDigest[];
  };
  /** Immutable Process output staged before B2. Removed from status after commit. */
  stagedProcess?: RuntimeProcessGeneration;
  articles: {
    total: number;
    pending: RuntimeJobArticle[];
    completed: number;
    excluded: number;
  };
  failures: RuntimeJobFailure[];
}

export interface RuntimeObjectInfo {
  objectName: string;
  size: number;
  uploadedAt?: string;
}

export interface RuntimeObjectStore {
  upload(objectName: string, localFile: string): Promise<void>;
  download(objectName: string, localFile: string, options?: RuntimeReadOptions): Promise<boolean>;
  readText(objectName: string, options?: RuntimeReadOptions): Promise<string | null>;
  info(objectName: string): Promise<RuntimeObjectInfo | null>;
  list(prefix: string): Promise<RuntimeObjectInfo[]>;
  delete(objectNames: readonly string[]): Promise<void>;
}

function positiveLimit(value: unknown, hardLimit: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > hardLimit) {
    throw new Error(`${label} must be a positive integer no greater than ${hardLimit}`);
  }
  return value as number;
}

export function runtimeReadLimit(options: RuntimeReadOptions | undefined, hardLimit: number, label: string): number {
  return options?.maxBytes === undefined ? hardLimit : positiveLimit(options.maxBytes, hardLimit, label);
}

export function runtimeArchiveLimits(overrides?: Partial<RuntimeArchiveLimits>): RuntimeArchiveLimits {
  return {
    maxEntries: overrides?.maxEntries === undefined
      ? RUNTIME_ARCHIVE_LIMITS.maxEntries
      : positiveLimit(overrides.maxEntries, RUNTIME_ARCHIVE_LIMITS.maxEntries, "Runtime archive entry limit"),
    maxEntryBytes: overrides?.maxEntryBytes === undefined
      ? RUNTIME_ARCHIVE_LIMITS.maxEntryBytes
      : positiveLimit(overrides.maxEntryBytes, RUNTIME_ARCHIVE_LIMITS.maxEntryBytes, "Runtime archive per-file limit"),
    maxExpandedBytes: overrides?.maxExpandedBytes === undefined
      ? RUNTIME_ARCHIVE_LIMITS.maxExpandedBytes
      : positiveLimit(overrides.maxExpandedBytes, RUNTIME_ARCHIVE_LIMITS.maxExpandedBytes, "Runtime archive expanded-size limit"),
  };
}

export function assertRuntimeFileBudget(
  files: readonly RuntimeFileDigest[],
  label: string,
  overrides?: Partial<RuntimeArchiveLimits>,
): RuntimeArchiveLimits {
  const limits = runtimeArchiveLimits(overrides);
  if (files.length > limits.maxEntries) {
    throw new Error(`${label} has ${files.length} files; limit is ${limits.maxEntries}`);
  }
  let expandedBytes = 0;
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error(`${label} has an invalid file size for ${file.path}`);
    }
    if (file.size > limits.maxEntryBytes) {
      throw new Error(`${label} file exceeds ${limits.maxEntryBytes} bytes: ${file.path}`);
    }
    if (file.size > limits.maxExpandedBytes - expandedBytes) {
      throw new Error(`${label} expands beyond ${limits.maxExpandedBytes} bytes`);
    }
    expandedBytes += file.size;
  }
  return limits;
}

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SOURCE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function safeJobId(value: unknown): string {
  if (typeof value !== "string" || !JOB_ID.test(value)) {
    throw new Error(`Invalid Runtime job id: ${String(value)}`);
  }
  return value;
}

export function safeSourceId(value: unknown): string {
  if (typeof value !== "string" || !SOURCE_ID.test(value)) {
    throw new Error(`Invalid Runtime source id: ${String(value)}`);
  }
  return value;
}

export function safeRuntimePath(value: unknown, label = "Runtime path"): string {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
  const parts = value.split("/");
  if (
    value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
    || parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  return value;
}

const PROCESS_GENERATION_OBJECT = /^times\/jobs\/([^/]+)\/processed-([a-f0-9]{64})\.tar\.gz$/u;

export function processGenerationObjectName(jobIdValue: unknown, sha256Value: unknown): string {
  const jobId = safeJobId(jobIdValue);
  const digest = sha256(sha256Value, "Process generation SHA-256");
  return `${RUNTIME_PREFIX}/jobs/${jobId}/processed-${digest}.tar.gz`;
}

export function parseProcessGenerationObjectName(value: unknown): {
  objectName: string;
  jobId: string;
  sha256: string;
} {
  const objectName = safeRuntimePath(value, "Process generation object");
  const match = PROCESS_GENERATION_OBJECT.exec(objectName);
  if (!match?.[1] || !match[2]) throw new Error(`Invalid Process generation object: ${objectName}`);
  return {
    objectName,
    jobId: safeJobId(match[1]),
    sha256: sha256(match[2], "Process generation object SHA-256"),
  };
}

const PROCESS_RESULT_OBJECT = "runtime/process-result.json";
const PROCESS_MANIFEST_OBJECT = "runtime/memory.json";

function parseProcessFiles(value: unknown, label: string): RuntimeFileDigest[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} files are invalid`);
  const paths = new Set<string>();
  const files = value.map((file, index): RuntimeFileDigest => {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      throw new Error(`${label} file ${index} is invalid`);
    }
    const row = file as Record<string, unknown>;
    const filePath = safeRuntimePath(row.path, `${label} file path ${index}`);
    if (!(filePath.startsWith("canonical/")
      || /^raw\/[a-z0-9]+(?:-[a-z0-9]+)*\/assets\//u.test(filePath)
      || filePath === PROCESS_RESULT_OBJECT
      || filePath === PROCESS_MANIFEST_OBJECT)) {
      throw new Error(`${label} file is outside its allowed scope: ${filePath}`);
    }
    if (paths.has(filePath)) throw new Error(`Duplicate ${label} file: ${filePath}`);
    paths.add(filePath);
    return {
      path: filePath,
      size: nonNegativeInteger(row.size, `${label} file size ${index}`),
      sha256: sha256(row.sha256, `${label} file SHA-256 ${index}`),
    };
  });
  assertRuntimeFileBudget(files, `${label} manifest`);
  return files;
}

function parseProcessArchive(value: unknown, label: string, expectedJobId?: string): RuntimeProcessArchive {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const row = value as Record<string, unknown>;
  const parsedObject = parseProcessGenerationObjectName(row.objectName);
  if (expectedJobId && parsedObject.jobId !== safeJobId(expectedJobId)) {
    throw new Error(`${label} belongs to a different job`);
  }
  const archiveSha256 = sha256(row.sha256, `${label} archive SHA-256`);
  if (parsedObject.sha256 !== archiveSha256) throw new Error(`${label} object does not match its SHA-256`);
  const files = parseProcessFiles(row.files, label);
  const paths = new Set(files.map((file) => file.path));
  if (!paths.has(PROCESS_RESULT_OBJECT) || !paths.has(PROCESS_MANIFEST_OBJECT)) {
    throw new Error(`${label} archive is missing its result or memory manifest`);
  }
  const size = runtimeObjectSize(row.size, `${label} archive size`);
  if (size === 0) throw new Error(`${label} archive is empty`);
  return {
    objectName: parsedObject.objectName,
    size,
    sha256: archiveSha256,
    files,
  };
}

export function parseRuntimeProcessGeneration(value: unknown, expectedJobId?: string): RuntimeProcessGeneration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime Process generation is invalid");
  }
  const row = value as Record<string, unknown>;
  const archive = parseProcessArchive(row, "Runtime Process generation", expectedJobId);
  const jobId = parseProcessGenerationObjectName(archive.objectName).jobId;
  let jobIds: string[] | undefined;
  if (row.jobIds !== undefined) {
    if (!Array.isArray(row.jobIds) || row.jobIds.length === 0 || row.jobIds.length > 20) {
      throw new Error("Runtime Process generation job ids are invalid");
    }
    jobIds = row.jobIds.map((entry) => safeJobId(entry));
    if (jobIds[0] !== jobId || new Set(jobIds).size !== jobIds.length) {
      throw new Error("Runtime Process generation job ids must be unique and start with the anchor job");
    }
  }

  const deltaFields = [row.base, row.stateFiles, row.deltaDepth];
  const populatedDeltaFields = deltaFields.filter((field) => field !== undefined).length;
  let delta: Pick<RuntimeProcessGeneration, "base" | "stateFiles" | "deltaDepth"> = {};
  if (populatedDeltaFields !== 0) {
    if (populatedDeltaFields !== deltaFields.length) {
      throw new Error("Runtime Process delta descriptor is incomplete");
    }
    const base = parseProcessArchive(row.base, "Runtime Process delta base");
    if (base.objectName === archive.objectName) throw new Error("Runtime Process delta cannot reference itself as its base");
    const stateFiles = parseProcessFiles(row.stateFiles, "Runtime Process effective state");
    assertRuntimeFileBudget([...base.files, ...archive.files], "Runtime Process delta layers");
    if (stateFiles.some((file) => file.path === PROCESS_MANIFEST_OBJECT)) {
      throw new Error("Runtime Process effective state cannot contain its synthetic memory manifest");
    }
    if (!stateFiles.some((file) => file.path === PROCESS_RESULT_OBJECT)) {
      throw new Error("Runtime Process effective state is missing its result");
    }
    const deltaDepth = nonNegativeInteger(row.deltaDepth, "Runtime Process delta depth");
    if (deltaDepth < 1 || deltaDepth > 12) throw new Error("Runtime Process delta depth must be from 1 to 12");

    const available = new Map(base.files.map((file) => [file.path, file]));
    for (const file of archive.files) {
      if (file.path !== PROCESS_MANIFEST_OBJECT) available.set(file.path, file);
    }
    const effectivePaths = new Set(stateFiles.map((file) => file.path));
    for (const file of archive.files) {
      if (file.path !== PROCESS_MANIFEST_OBJECT && !effectivePaths.has(file.path)) {
        throw new Error(`Runtime Process delta contains a file outside its effective state: ${file.path}`);
      }
    }
    for (const file of stateFiles) {
      const source = available.get(file.path);
      if (!source || source.size !== file.size || source.sha256 !== file.sha256) {
        throw new Error(`Runtime Process effective state is not supplied by its base or delta: ${file.path}`);
      }
    }
    delta = { base, stateFiles, deltaDepth };
  }

  return {
    ...archive,
    createdAt: exactTimestamp(row.createdAt, "Runtime Process generation createdAt"),
    ...(jobIds ? { jobIds } : {}),
    ...delta,
  };
}

export function runtimeProcessGenerationObjects(generation: RuntimeProcessGeneration): string[] {
  return [...new Set([generation.objectName, ...(generation.base ? [generation.base.objectName] : [])])];
}

export function jobObjectNames(jobIdValue: unknown): { raw: string; status: string } {
  const jobId = safeJobId(jobIdValue);
  return {
    raw: `${RUNTIME_PREFIX}/jobs/${jobId}/raw.tar`,
    status: `${RUNTIME_PREFIX}/jobs/${jobId}/status.json`,
  };
}

export function pendingJobObjectName(jobIdValue: unknown): string {
  return `${PENDING_JOB_PREFIX}/${safeJobId(jobIdValue)}.json`;
}

function exactTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
  return value as number;
}

function runtimeObjectSize(value: unknown, label: string): number {
  const size = nonNegativeInteger(value, label);
  if (size > RUNTIME_MAX_DOWNLOAD_BYTES) {
    throw new Error(`${label} exceeds the Runtime download limit of ${RUNTIME_MAX_DOWNLOAD_BYTES} bytes`);
  }
  return size;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
  return value;
}

function parseArticle(value: unknown, label: string): RuntimeJobArticle {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const row = value as { sourceId?: unknown; articleId?: unknown };
  const sourceId = safeSourceId(row.sourceId);
  if (typeof row.articleId !== "string" || !row.articleId.trim()) throw new Error(`${label} has an invalid article id`);
  return { sourceId, articleId: row.articleId };
}

export function parseRuntimeJobStatus(value: unknown): RuntimeJobStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Runtime job status must be an object");
  const input = value as Record<string, unknown>;
  if (input.formatVersion !== "jojo-times-job/1") {
    throw new Error(`Unsupported Runtime job format: ${String(input.formatVersion)}`);
  }
  const jobId = safeJobId(input.jobId);
  if (typeof input.runId !== "string" || !input.runId.trim()) throw new Error("Runtime job runId is invalid");
  if (input.state !== "ready" && input.state !== "partial" && input.state !== "done") {
    throw new Error(`Invalid Runtime job state: ${String(input.state)}`);
  }
  if (!input.raw || typeof input.raw !== "object" || Array.isArray(input.raw)) {
    throw new Error("Runtime job raw descriptor is invalid");
  }
  const raw = input.raw as Record<string, unknown>;
  const expectedObjects = jobObjectNames(jobId);
  if (raw.objectName !== expectedObjects.raw) throw new Error("Runtime job raw object does not match its job id");
  if (!Array.isArray(raw.files)) throw new Error("Runtime job raw files must be an array");
  const paths = new Set<string>();
  const files = raw.files.map((file, index): RuntimeFileDigest => {
    if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error(`Runtime raw file ${index} is invalid`);
    const row = file as Record<string, unknown>;
    const filePath = safeRuntimePath(row.path, `Runtime raw file path ${index}`);
    if (!filePath.startsWith("raw/")) throw new Error(`Runtime raw file is outside raw/: ${filePath}`);
    if (paths.has(filePath)) throw new Error(`Duplicate Runtime raw file: ${filePath}`);
    paths.add(filePath);
    return {
      path: filePath,
      size: nonNegativeInteger(row.size, `Runtime raw file size ${index}`),
      sha256: sha256(row.sha256, `Runtime raw file SHA-256 ${index}`),
    };
  });
  assertRuntimeFileBudget(files, "Runtime Raw manifest");
  const runManifest = safeRuntimePath(input.runManifest, "Runtime Raw run manifest");
  if (!/^raw\/runs\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9._-]+\.json$/u.test(runManifest) || !paths.has(runManifest)) {
    throw new Error("Runtime Raw run manifest is invalid or absent from the archive");
  }
  if (!input.articles || typeof input.articles !== "object" || Array.isArray(input.articles)) {
    throw new Error("Runtime job article summary is invalid");
  }
  const articleInput = input.articles as Record<string, unknown>;
  if (!Array.isArray(articleInput.pending)) throw new Error("Runtime pending articles must be an array");
  const pending = articleInput.pending.map((article, index) => parseArticle(article, `Runtime pending article ${index}`));
  const articleKeys = pending.map((row) => `${row.sourceId}\0${row.articleId}`);
  if (new Set(articleKeys).size !== articleKeys.length) throw new Error("Runtime pending articles contain duplicates");
  if (!Array.isArray(input.failures)) throw new Error("Runtime job failures must be an array");
  const failures = input.failures.map((failure, index): RuntimeJobFailure => {
    const article = parseArticle(failure, `Runtime job failure ${index}`);
    const reason = (failure as { reason?: unknown }).reason;
    if (typeof reason !== "string" || !reason.trim()) throw new Error(`Runtime job failure ${index} has no reason`);
    return { ...article, reason };
  });
  const total = nonNegativeInteger(articleInput.total, "Runtime job article total");
  const completed = nonNegativeInteger(articleInput.completed, "Runtime job completed article count");
  const excluded = nonNegativeInteger(articleInput.excluded, "Runtime job excluded article count");
  if (completed + excluded + pending.length !== total) {
    throw new Error("Runtime job article counts do not add up");
  }
  if (input.state === "done" && pending.length !== 0) throw new Error("A done Runtime job cannot have pending articles");
  let stagedProcess: RuntimeProcessGeneration | undefined;
  if (input.stagedProcess !== undefined) {
    stagedProcess = parseRuntimeProcessGeneration(input.stagedProcess, jobId);
  }
  return {
    formatVersion: "jojo-times-job/1",
    jobId,
    runId: input.runId,
    runManifest,
    createdAt: exactTimestamp(input.createdAt, "Runtime job createdAt"),
    updatedAt: exactTimestamp(input.updatedAt, "Runtime job updatedAt"),
    state: input.state,
    attempts: nonNegativeInteger(input.attempts, "Runtime job attempts"),
    raw: {
      objectName: expectedObjects.raw,
      size: runtimeObjectSize(raw.size, "Runtime raw archive size"),
      sha256: sha256(raw.sha256, "Runtime raw archive SHA-256"),
      files,
    },
    ...(stagedProcess ? { stagedProcess } : {}),
    articles: { total, pending, completed, excluded },
    failures,
  };
}
