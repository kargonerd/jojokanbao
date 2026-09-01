import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PENDING_JOBS_OBJECT,
  type RuntimeJobStatus,
  type RuntimeObjectInfo,
  type RuntimeObjectStore,
  safeJobId,
} from "./types.js";
import { readRuntimeJob } from "./jobs.js";

interface RuntimeQueueEntry {
  jobId: string;
  createdAt: string;
}

interface RuntimeJobQueue {
  formatVersion: "jojo-times-pending-jobs/1";
  updatedAt: string;
  jobs: RuntimeQueueEntry[];
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`Invalid ${label}`);
  return value;
}

function parseQueue(value: unknown): RuntimeJobQueue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Runtime pending job queue is invalid");
  const input = value as Record<string, unknown>;
  if (input.formatVersion !== "jojo-times-pending-jobs/1" || !Array.isArray(input.jobs)) {
    throw new Error("Runtime pending job queue has an unsupported format");
  }
  const seen = new Set<string>();
  const jobs = input.jobs.map((value, index): RuntimeQueueEntry => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Runtime queue entry ${index} is invalid`);
    const row = value as Record<string, unknown>;
    const jobId = safeJobId(row.jobId);
    if (seen.has(jobId)) throw new Error(`Runtime queue contains duplicate job ${jobId}`);
    seen.add(jobId);
    return { jobId, createdAt: timestamp(row.createdAt, `Runtime queue createdAt for ${jobId}`) };
  });
  return {
    formatVersion: "jojo-times-pending-jobs/1",
    updatedAt: timestamp(input.updatedAt, "Runtime queue updatedAt"),
    jobs: jobs.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.jobId.localeCompare(right.jobId)),
  };
}

async function readQueue(store: RuntimeObjectStore): Promise<RuntimeJobQueue> {
  const body = await store.readText(PENDING_JOBS_OBJECT);
  if (body === null) {
    return { formatVersion: "jojo-times-pending-jobs/1", updatedAt: new Date(0).toISOString(), jobs: [] };
  }
  try {
    return parseQueue(JSON.parse(body) as unknown);
  } catch (error) {
    process.stderr.write(`[runtime] pending-jobs.json is invalid and will be rebuilt: ${error instanceof Error ? error.message : String(error)}\n`);
    return { formatVersion: "jojo-times-pending-jobs/1", updatedAt: new Date(0).toISOString(), jobs: [] };
  }
}

async function writeQueue(
  store: RuntimeObjectStore,
  queueValue: RuntimeJobQueue,
  workDirectory: string,
  now: Date,
): Promise<void> {
  const queue = parseQueue({ ...queueValue, updatedAt: now.toISOString() });
  const file = path.resolve(workDirectory, "pending-jobs.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(queue, null, 2)}\n`);
  await store.upload(PENDING_JOBS_OBJECT, file);
}

async function activeStatusesSinceQueue(
  store: RuntimeObjectStore,
  queue: RuntimeJobQueue,
): Promise<RuntimeJobStatus[]> {
  const queueIds = new Set(queue.jobs.map((entry) => entry.jobId));
  const queueUpdatedAt = Date.parse(queue.updatedAt);
  const recentThreshold = Number.isFinite(queueUpdatedAt) ? queueUpdatedAt - 5 * 60_000 : 0;
  const listedStatuses = (await store.list("times/jobs"))
    .map((object) => ({
      object,
      jobId: /^times\/jobs\/([^/]+)\/status\.json$/u.exec(object.objectName)?.[1],
    }))
    .filter((row): row is { object: RuntimeObjectInfo; jobId: string } => Boolean(row.jobId))
    .map((row) => ({ ...row, jobId: safeJobId(row.jobId) }));
  const candidateIds = new Set(queue.jobs.map((entry) => entry.jobId));
  for (const { object, jobId } of listedStatuses) {
    if (queueIds.has(jobId)) continue;
    const uploadedAt = object.uploadedAt ? Date.parse(object.uploadedAt) : Number.NaN;
    if (!Number.isFinite(uploadedAt) || uploadedAt >= recentThreshold) candidateIds.add(jobId);
  }
  const active: RuntimeJobStatus[] = [];
  for (const jobId of candidateIds) {
    try {
      const status = await readRuntimeJob(store, jobId);
      if (status && status.state !== "done") active.push(status);
    } catch (error) {
      process.stderr.write(`[runtime] ignoring malformed Runtime job ${jobId}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  return active;
}

export async function enqueueRuntimeJob(options: {
  store: RuntimeObjectStore;
  status: RuntimeJobStatus;
  workDirectory: string;
  now?: Date;
}): Promise<void> {
  const queue = await readQueue(options.store);
  const recovered = await activeStatusesSinceQueue(options.store, queue);
  const jobs = recovered.filter((job) => job.jobId !== options.status.jobId)
    .map((job) => ({ jobId: job.jobId, createdAt: job.createdAt }));
  jobs.push({ jobId: options.status.jobId, createdAt: options.status.createdAt });
  await writeQueue(options.store, { ...queue, jobs }, options.workDirectory, options.now ?? new Date());
}

function partialRetryDue(status: RuntimeJobStatus, now: Date): boolean {
  if (status.state !== "partial") return true;
  const exponent = Math.max(0, Math.min(status.attempts - 1, 6));
  const delayMs = Math.min(6 * 3_600_000, 10 * 60_000 * 2 ** exponent);
  return now.valueOf() - Date.parse(status.updatedAt) >= delayMs;
}

function uniqueStagedJob(statuses: readonly RuntimeJobStatus[]): RuntimeJobStatus | undefined {
  const staged = statuses.filter((status) => status.stagedProcess !== undefined)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.jobId.localeCompare(right.jobId));
  if (staged.length > 1) {
    throw new Error(`Runtime has multiple staged Process jobs and cannot select safely: ${staged.map((status) => status.jobId).join(", ")}`);
  }
  return staged[0];
}

export async function selectRuntimeJob(options: {
  store: RuntimeObjectStore;
  workDirectory: string;
  preferredJobId?: string;
  exactPreferred?: boolean;
  now?: Date;
}): Promise<RuntimeJobStatus | null> {
  const now = options.now ?? new Date();
  let exact: RuntimeJobStatus | undefined;
  if (options.exactPreferred) {
    if (!options.preferredJobId) throw new Error("An exact Runtime job selection requires a job id");
    exact = await readRuntimeJob(options.store, options.preferredJobId) ?? undefined;
    if (!exact) throw new Error(`Runtime job does not exist: ${options.preferredJobId}`);
    if (exact.state === "done") throw new Error(`Runtime job is already done: ${options.preferredJobId}`);
  }
  const queue = await readQueue(options.store);
  const active = await activeStatusesSinceQueue(options.store, queue);
  const staged = uniqueStagedJob([
    ...active,
    ...(exact && !active.some((status) => status.jobId === exact.jobId) ? [exact] : []),
  ]);
  if (exact) {
    if (staged && staged.jobId !== exact.jobId) {
      throw new Error(`Exact Runtime job ${exact.jobId} cannot bypass staged Process job ${staged.jobId}`);
    }
    return exact;
  }
  const activeIds = new Set(active.map((status) => status.jobId));
  const queueIds = new Set(queue.jobs.map((entry) => entry.jobId));
  const repaired = queue.jobs.some((entry) => !activeIds.has(entry.jobId))
    || active.some((status) => !queueIds.has(status.jobId));
  if (repaired) {
    await writeQueue(options.store, {
      ...queue,
      jobs: active.map((status) => ({ jobId: status.jobId, createdAt: status.createdAt })),
    }, options.workDirectory, now);
  }
  if (staged) return staged;
  const duePartial = active.filter((status) => status.state === "partial" && partialRetryDue(status, now))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.jobId.localeCompare(right.jobId));
  if (duePartial[0]) return duePartial[0];
  const ready = active.filter((status) => status.state === "ready")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.jobId.localeCompare(right.jobId));
  if (ready[0]) return ready[0];
  return null;
}

export async function updateRuntimeQueueAfterDelivery(options: {
  store: RuntimeObjectStore;
  status: RuntimeJobStatus;
  workDirectory: string;
  now?: Date;
}): Promise<void> {
  const queue = await readQueue(options.store);
  const recovered = await activeStatusesSinceQueue(options.store, queue);
  const jobs = recovered.filter((entry) => entry.jobId !== options.status.jobId)
    .map((entry) => ({ jobId: entry.jobId, createdAt: entry.createdAt }));
  if (options.status.state !== "done") jobs.push({ jobId: options.status.jobId, createdAt: options.status.createdAt });
  await writeQueue(options.store, { ...queue, jobs }, options.workDirectory, options.now ?? new Date());
}
