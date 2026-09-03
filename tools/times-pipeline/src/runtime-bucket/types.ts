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

export interface RuntimeProcessGeneration {
  objectName: string;
  createdAt: string;
  size: number;
  sha256: string;
  files: RuntimeFileDigest[];
  /** Ordered Runtime jobs committed by this generation. Absent on legacy single-job generations. */
  jobIds?: string[];
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
    if (!input.stagedProcess || typeof input.stagedProcess !== "object" || Array.isArray(input.stagedProcess)) {
      throw new Error("Runtime staged Process descriptor is invalid");
    }
    const staged = input.stagedProcess as Record<string, unknown>;
    if (!Array.isArray(staged.files) || staged.files.length === 0) {
      throw new Error("Runtime staged Process files are invalid");
    }
    const stagedSha256 = sha256(staged.sha256, "Runtime staged Process archive SHA-256");
    if (staged.objectName !== processGenerationObjectName(jobId, stagedSha256)) {
      throw new Error("Runtime staged Process object does not match its job id and SHA-256");
    }
    const stagedPaths = new Set<string>();
    const stagedFiles = staged.files.map((file, index): RuntimeFileDigest => {
      if (!file || typeof file !== "object" || Array.isArray(file)) {
        throw new Error(`Runtime staged Process file ${index} is invalid`);
      }
      const row = file as Record<string, unknown>;
      const filePath = safeRuntimePath(row.path, `Runtime staged Process file path ${index}`);
      if (!(filePath.startsWith("canonical/")
        || /^raw\/[a-z0-9]+(?:-[a-z0-9]+)*\/assets\//u.test(filePath)
        || filePath === "runtime/process-result.json"
        || filePath === "runtime/memory.json")) {
        throw new Error(`Runtime staged Process file is outside its allowed scope: ${filePath}`);
      }
      if (stagedPaths.has(filePath)) throw new Error(`Duplicate Runtime staged Process file: ${filePath}`);
      stagedPaths.add(filePath);
      return {
        path: filePath,
        size: nonNegativeInteger(row.size, `Runtime staged Process file size ${index}`),
        sha256: sha256(row.sha256, `Runtime staged Process file SHA-256 ${index}`),
      };
    });
    assertRuntimeFileBudget(stagedFiles, "Runtime staged Process manifest");
    if (!stagedPaths.has("runtime/process-result.json") || !stagedPaths.has("runtime/memory.json")) {
      throw new Error("Runtime staged Process archive is missing its result or memory manifest");
    }
    stagedProcess = {
      objectName: processGenerationObjectName(jobId, stagedSha256),
      createdAt: exactTimestamp(staged.createdAt, "Runtime staged Process createdAt"),
      size: runtimeObjectSize(staged.size, "Runtime staged Process archive size"),
      sha256: stagedSha256,
      files: stagedFiles,
      ...(staged.jobIds === undefined ? {} : {
        jobIds: (() => {
          if (!Array.isArray(staged.jobIds) || staged.jobIds.length === 0 || staged.jobIds.length > 20) {
            throw new Error("Runtime staged Process job ids are invalid");
          }
          const jobIds = staged.jobIds.map((value) => safeJobId(value));
          if (jobIds[0] !== jobId || new Set(jobIds).size !== jobIds.length) {
            throw new Error("Runtime staged Process job ids must be unique and start with the anchor job");
          }
          return jobIds;
        })(),
      }),
    };
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
