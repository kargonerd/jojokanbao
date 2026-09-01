import {
  jobObjectNames,
  parseProcessGenerationObjectName,
  safeJobId,
  type RuntimeJobState,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const STATUS_OBJECT = /^times\/jobs\/([^/]+)\/status\.json$/u;
const PAYLOAD_OBJECT = /^times\/jobs\/([^/]+)\/(?:raw\.tar|processed-[a-f0-9]{64}\.tar\.gz)$/u;

export const DEFAULT_RUNTIME_CLEANUP_MAX_JOBS = 100;

export interface RuntimeJobStatusSummary {
  objectName: string;
  state: RuntimeJobState;
  updatedAt: string;
  stagedProcessObject?: string;
}

export interface RuntimeBucketCleanupOptions {
  now: Date;
  /** A plan is a dry run unless its caller opts in explicitly. */
  apply?: boolean;
  maxDeleteJobs?: number;
  /** Payloads still referenced by a committed pointer must never be deleted. */
  protectedPayloadObjects?: readonly string[];
}

export interface RuntimeOrphanPayloadSummary {
  objectName: string;
  uploadedAt: string;
}

export interface RuntimeBucketCleanupJob {
  jobId: string;
  state: RuntimeJobState;
  updatedAt: string;
  retentionDays: 14 | 30;
  requiresAlert: boolean;
  objects: string[];
}

export interface RuntimeBucketCleanupPlan {
  mode: "dry-run" | "apply";
  jobs: RuntimeBucketCleanupJob[];
  /** Exact object deletion order: payload first, status marker last. */
  objects: string[];
  orphanObjects: string[];
}

function validDate(value: Date, label: string): number {
  const timestamp = value.valueOf();
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be a valid Date`);
  return timestamp;
}

function updatedTimestamp(value: unknown, objectName: string): number {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Runtime job status has an invalid updatedAt: ${objectName}`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Runtime job status has an invalid updatedAt: ${objectName}`);
  }
  return timestamp;
}

function jobState(value: unknown, objectName: string): RuntimeJobState {
  if (value === "ready" || value === "partial" || value === "done") return value;
  throw new Error(`Runtime job status has an invalid state: ${objectName}`);
}

function statusJobId(objectName: unknown): string {
  if (typeof objectName !== "string") throw new Error("Runtime job object name must be a string");
  const match = STATUS_OBJECT.exec(objectName);
  const jobId = match?.[1];
  if (!jobId) {
    throw new Error(`Unsafe Runtime job status object: ${objectName}`);
  }
  try {
    return safeJobId(jobId);
  } catch {
    throw new Error(`Unsafe Runtime job status object: ${objectName}`);
  }
}

function maximumJobs(value: number | undefined): number {
  const resolved = value ?? DEFAULT_RUNTIME_CLEANUP_MAX_JOBS;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error("maxDeleteJobs must be a positive integer");
  }
  return resolved;
}

function payloadJobId(objectName: unknown, label: string): string {
  if (typeof objectName !== "string") throw new Error(`${label} must be a string`);
  const match = PAYLOAD_OBJECT.exec(objectName);
  if (!match?.[1]) throw new Error(`Unsafe ${label}: ${objectName}`);
  const jobId = safeJobId(match[1]);
  if (objectName.includes("/processed-")) {
    const parsed = parseProcessGenerationObjectName(objectName);
    if (parsed.jobId !== jobId) throw new Error(`Unsafe ${label}: ${objectName}`);
  }
  return jobId;
}

/**
 * Build a deterministic, side-effect-free Runtime Bucket retention plan.
 * Consumers must inspect `mode` and perform deletion themselves.
 */
export function planRuntimeBucketCleanup(
  summaries: readonly RuntimeJobStatusSummary[],
  options: RuntimeBucketCleanupOptions,
  orphanPayloads: readonly RuntimeOrphanPayloadSummary[] = [],
): RuntimeBucketCleanupPlan {
  const now = validDate(options.now, "now");
  if (options.apply !== undefined && typeof options.apply !== "boolean") {
    throw new Error("apply must be a boolean");
  }
  const limit = maximumJobs(options.maxDeleteJobs);
  const protectedPayloads = new Set((options.protectedPayloadObjects ?? []).map((objectName) => {
    payloadJobId(objectName, "Runtime protected payload object");
    return objectName;
  }));
  const seen = new Set<string>();
  const jobs: RuntimeBucketCleanupJob[] = [];

  for (const summary of summaries) {
    if (!summary || typeof summary !== "object") {
      throw new Error("Runtime job status summary must be an object");
    }
    const jobId = statusJobId(summary.objectName);
    if (seen.has(jobId)) throw new Error(`Duplicate Runtime job status: ${jobId}`);
    seen.add(jobId);
    const state = jobState(summary.state, summary.objectName);
    const updatedAt = updatedTimestamp(summary.updatedAt, summary.objectName);
    const objects = jobObjectNames(jobId);
    if (summary.stagedProcessObject !== undefined) {
      let stagedJobId: string;
      try {
        stagedJobId = parseProcessGenerationObjectName(summary.stagedProcessObject).jobId;
      } catch {
        throw new Error(`Unsafe Runtime staged Process object: ${String(summary.stagedProcessObject)}`);
      }
      if (stagedJobId !== jobId) {
        throw new Error(`Unsafe Runtime staged Process object: ${String(summary.stagedProcessObject)}`);
      }
    }
    const retentionDays = state === "done" ? 14 : 30;
    if (now - updatedAt <= retentionDays * DAY_MS) continue;
    jobs.push({
      jobId,
      state,
      updatedAt: summary.updatedAt,
      retentionDays,
      requiresAlert: state !== "done",
      objects: [
        ...[objects.raw, summary.stagedProcessObject]
          .filter((objectName): objectName is string => (
            typeof objectName === "string" && !protectedPayloads.has(objectName)
          )),
        objects.status,
      ],
    });
  }

  jobs.sort((left, right) => left.jobId.localeCompare(right.jobId));
  const orphanJobs = new Set<string>();
  const orphanObjects: string[] = [];
  for (const orphan of orphanPayloads) {
    if (!orphan || typeof orphan !== "object") throw new Error("Runtime orphan payload summary must be an object");
    const jobId = payloadJobId(orphan.objectName, "Runtime orphan payload object");
    const uploadedAt = updatedTimestamp(orphan.uploadedAt, orphan.objectName);
    if (now - uploadedAt <= 30 * DAY_MS) continue;
    if (protectedPayloads.has(orphan.objectName)) continue;
    orphanJobs.add(jobId);
    orphanObjects.push(orphan.objectName);
  }
  orphanObjects.sort((left, right) => left.localeCompare(right));
  if (new Set(orphanObjects).size !== orphanObjects.length) throw new Error("Duplicate Runtime orphan payload object");
  const affectedJobs = new Set([...jobs.map((job) => job.jobId), ...orphanJobs]);
  if (affectedJobs.size > limit) {
    throw new Error(`Runtime cleanup would delete ${affectedJobs.size} jobs, exceeding maxDeleteJobs ${limit}`);
  }
  return {
    mode: options.apply === true ? "apply" : "dry-run",
    jobs,
    objects: [...jobs.flatMap((job) => job.objects), ...orphanObjects],
    orphanObjects,
  };
}
