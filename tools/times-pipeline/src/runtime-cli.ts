import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, requiredArg } from "./args.js";
import { HfRuntimeBucket } from "./runtime-bucket/store.js";
import {
  publishRuntimeJob,
  publishRuntimeJobStatus,
  readRuntimeJob,
  restoreRuntimeJob,
  restoreRuntimeJobBatch,
  statusAfterSuccessfulDelivery,
  statusAfterRuntimeFailure,
} from "./runtime-bucket/jobs.js";
import { publishRuntimeMemory, restoreRuntimeMemory, type RuntimeMemoryKind } from "./runtime-bucket/memory.js";
import { planRuntimeBucketCleanup, type RuntimeJobStatusSummary } from "./runtime-bucket/cleanup.js";
import {
  RUNTIME_PREFIX,
  parseRuntimeJobStatus,
  pendingJobObjectName,
  safeJobId,
} from "./runtime-bucket/types.js";
import { enqueueRuntimeJob, selectRuntimeJob, selectRuntimeJobs, updateRuntimeQueueAfterDelivery } from "./runtime-bucket/queue.js";
import {
  assertRuntimeProcessGenerationUncommitted,
  committedRuntimeProcessGeneration,
  promoteRuntimeProcess,
  restoreRuntimeProcess,
  stageRuntimeProcess,
} from "./runtime-bucket/process-generation.js";

function token(args: Map<string, string>): string {
  const environmentName = args.get("token-env") ?? "HF_TOKEN";
  const value = process.env[environmentName]?.trim();
  if (!value) throw new Error(`${environmentName} is not configured`);
  return value;
}

function memoryKind(args: Map<string, string>): RuntimeMemoryKind {
  const value = requiredArg(args, "kind");
  if (value !== "capture" && value !== "process") throw new Error("--kind must be capture or process");
  return value;
}

async function jobIdsFromFile(args: Map<string, string>): Promise<string[]> {
  const value = JSON.parse(await readFile(path.resolve(requiredArg(args, "job-ids-file")), "utf8")) as unknown;
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error("Runtime job ids file must contain an array of 1 to 20 job ids");
  }
  const jobIds = value.map((jobId) => safeJobId(jobId));
  if (new Set(jobIds).size !== jobIds.length) throw new Error("Runtime job ids file contains duplicates");
  return jobIds;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const action = requiredArg(args, "action");
  const output = path.resolve(requiredArg(args, "output"));
  const workDirectory = path.resolve(args.get("work-directory") ?? path.join(output, ".runtime-work"));
  const store = new HfRuntimeBucket(requiredArg(args, "bucket"), token(args));

  if (action === "restore-memory") {
    const kind = memoryKind(args);
    if (kind === "process") throw new Error("Use --action restore-process for Process memory");
    process.stdout.write(`${JSON.stringify(await restoreRuntimeMemory({
      store,
      output,
      workDirectory,
      kind,
    }), null, 2)}\n`);
    return;
  }
  if (action === "publish-job") {
    const status = await publishRuntimeJob({
      store,
      output,
      workDirectory,
      jobId: requiredArg(args, "job-id"),
      runManifest: path.resolve(requiredArg(args, "run-manifest")),
    });
    await enqueueRuntimeJob({ store, status, workDirectory });
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }
  if (action === "select-job") {
    const preferredJobId = args.get("preferred-job-id");
    const status = await selectRuntimeJob({
      store,
      workDirectory,
      ...(preferredJobId ? { preferredJobId } : {}),
      exactPreferred: args.get("exact-job") === "true",
    });
    if (!status) throw new Error("Runtime has no ready or retryable job");
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }
  if (action === "select-jobs") {
    const preferredJobId = args.get("preferred-job-id");
    const statuses = await selectRuntimeJobs({
      store,
      workDirectory,
      ...(preferredJobId ? { preferredJobId } : {}),
      exactPreferred: args.get("exact-job") === "true",
      ...(args.get("max-jobs") ? { maxJobs: Number(args.get("max-jobs")) } : {}),
    });
    if (!statuses.length && args.get("allow-empty") !== "true") {
      throw new Error("Runtime has no ready or retryable job");
    }
    process.stdout.write(`${JSON.stringify({
      anchorJobId: statuses[0]?.jobId,
      jobIds: statuses.map((status) => status.jobId),
      jobs: statuses,
    }, null, 2)}\n`);
    return;
  }
  if (action === "restore-job") {
    const status = await restoreRuntimeJob({
      store,
      output,
      workDirectory,
      jobId: requiredArg(args, "job-id"),
    });
    const pendingArticlesFile = path.join(workDirectory, `${status.jobId}.pending-articles.json`);
    await mkdir(path.dirname(pendingArticlesFile), { recursive: true });
    await writeFile(pendingArticlesFile, `${JSON.stringify(status.articles.pending, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({
      ...status,
      localRunManifest: path.join(output, ...status.runManifest.split("/")),
      pendingArticlesFile,
    }, null, 2)}\n`);
    return;
  }
  if (action === "restore-jobs") {
    process.stdout.write(`${JSON.stringify(await restoreRuntimeJobBatch({
      store,
      output,
      workDirectory,
      jobIds: await jobIdsFromFile(args),
    }), null, 2)}\n`);
    return;
  }
  if (action === "publish-memory") {
    const kind = memoryKind(args);
    if (kind === "process") throw new Error("Use --action stage-process and promote-process for Process memory");
    process.stdout.write(`${JSON.stringify(await publishRuntimeMemory({
      store,
      output,
      workDirectory,
      kind,
      basedOnJobId: requiredArg(args, "job-id"),
      ...(args.get("retention-days") ? { processRetentionDays: Number(args.get("retention-days")) } : {}),
    }), null, 2)}\n`);
    return;
  }
  if (action === "restore-process") {
    const jobId = requiredArg(args, "job-id");
    const status = await readRuntimeJob(store, jobId);
    if (!status) throw new Error(`Runtime job does not exist: ${jobId}`);
    process.stdout.write(`${JSON.stringify(await restoreRuntimeProcess({
      store,
      output,
      workDirectory,
      status,
    }), null, 2)}\n`);
    return;
  }
  if (action === "stage-process") {
    const jobId = requiredArg(args, "job-id");
    const status = await readRuntimeJob(store, jobId);
    if (!status) throw new Error(`Runtime job does not exist: ${jobId}`);
    const updated = await stageRuntimeProcess({
      store,
      output,
      workDirectory,
      status,
      ...(args.get("job-ids-file") ? { jobIds: await jobIdsFromFile(args) } : {}),
      processResultFile: path.resolve(requiredArg(args, "process-result")),
      ...(args.get("retention-days") ? { retentionDays: Number(args.get("retention-days")) } : {}),
    });
    await publishRuntimeJobStatus({ store, status: updated, workDirectory });
    process.stdout.write(`${JSON.stringify(updated, null, 2)}\n`);
    return;
  }
  if (action === "promote-process") {
    const jobId = requiredArg(args, "job-id");
    const status = await readRuntimeJob(store, jobId);
    if (!status) throw new Error(`Runtime job does not exist: ${jobId}`);
    await promoteRuntimeProcess({ store, status, workDirectory });
    process.stdout.write(`${JSON.stringify({ jobId, promoted: true }, null, 2)}\n`);
    return;
  }
  if (action === "mark-job") {
    const jobId = requiredArg(args, "job-id");
    const status = await readRuntimeJob(store, jobId);
    if (!status) throw new Error(`Runtime job does not exist: ${jobId}`);
    const result = JSON.parse(await readFile(path.resolve(requiredArg(args, "process-result")), "utf8")) as unknown;
    const updated = statusAfterSuccessfulDelivery(status, result);
    await publishRuntimeJobStatus({ store, status: updated, workDirectory });
    await updateRuntimeQueueAfterDelivery({ store, status: updated, workDirectory });
    process.stdout.write(`${JSON.stringify(updated, null, 2)}\n`);
    return;
  }
  if (action === "mark-jobs") {
    const jobIds = await jobIdsFromFile(args);
    const result = JSON.parse(await readFile(path.resolve(requiredArg(args, "process-result")), "utf8")) as unknown;
    const anchor = await readRuntimeJob(store, jobIds[0]!);
    if (!anchor) throw new Error(`Runtime job does not exist: ${jobIds[0]}`);
    const stagedJobIds = anchor.stagedProcess?.jobIds ?? [anchor.jobId];
    if (anchor.stagedProcess && JSON.stringify(stagedJobIds) !== JSON.stringify(jobIds)) {
      throw new Error("Runtime staged Process batch does not match the jobs being marked");
    }
    const updatedById = new Map<string, ReturnType<typeof statusAfterSuccessfulDelivery>>();
    // Commit the anchor status last so a partial marker-update failure keeps the
    // staged batch discoverable and safely replayable.
    for (const jobId of [...jobIds.slice(1), jobIds[0]!]) {
      const status = await readRuntimeJob(store, jobId);
      if (!status) throw new Error(`Runtime job does not exist: ${jobId}`);
      const updated = status.state === "done" ? status : statusAfterSuccessfulDelivery(status, result);
      if (status.state !== "done") await publishRuntimeJobStatus({ store, status: updated, workDirectory });
      await updateRuntimeQueueAfterDelivery({ store, status: updated, workDirectory });
      updatedById.set(jobId, updated);
    }
    const jobs = jobIds.map((jobId) => updatedById.get(jobId)!);
    process.stdout.write(`${JSON.stringify({
      anchorJobId: jobIds[0],
      jobIds,
      state: jobs.some((status) => status.state === "partial") ? "partial" : "done",
      jobs,
    }, null, 2)}\n`);
    return;
  }
  if (action === "defer-job") {
    const jobId = requiredArg(args, "job-id");
    const status = await readRuntimeJob(store, jobId);
    if (!status) throw new Error(`Runtime job does not exist: ${jobId}`);
    const reasonFile = args.get("reason-file");
    const reason = reasonFile
      ? await readFile(path.resolve(reasonFile), "utf8")
      : args.get("reason") ?? "runtime-step-failed";
    const updated = statusAfterRuntimeFailure(status, reason);
    await publishRuntimeJobStatus({ store, status: updated, workDirectory });
    await updateRuntimeQueueAfterDelivery({ store, status: updated, workDirectory });
    process.stdout.write(`${JSON.stringify(updated, null, 2)}\n`);
    return;
  }
  if (action === "discard-staged-process") {
    const jobId = requiredArg(args, "job-id");
    const status = await readRuntimeJob(store, jobId);
    if (!status) throw new Error(`Runtime job does not exist: ${jobId}`);
    const objectName = status.stagedProcess?.objectName;
    if (objectName) {
      await assertRuntimeProcessGenerationUncommitted(store, objectName);
      const updated = { ...status };
      delete updated.stagedProcess;
      await publishRuntimeJobStatus({ store, status: updated, workDirectory });
      // Leave the immutable payload for orphan cleanup. Deleting here would
      // create an avoidable pointer race if another writer committed it.
    }
    process.stdout.write(`${JSON.stringify({ jobId, discarded: Boolean(objectName) }, null, 2)}\n`);
    return;
  }
  if (action === "show-job") {
    const status = await readRuntimeJob(store, requiredArg(args, "job-id"));
    if (!status) throw new Error("Runtime job does not exist");
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }
  if (action === "cleanup") {
    const runtimeObjects = await store.list(RUNTIME_PREFIX);
    const jobObjects = runtimeObjects.filter((object) => object.objectName.startsWith("times/jobs/"));
    const pendingObjects = runtimeObjects.filter((object) => /^times\/pending\/[^/]+\.json$/u.test(object.objectName));
    const pendingObjectNames = new Set(pendingObjects.map((object) => object.objectName));
    const statusObjects = jobObjects
      .filter((object) => /^times\/jobs\/[^/]+\/status\.json$/u.test(object.objectName));
    const committedProcess = await committedRuntimeProcessGeneration(store);
    const committedProcessObject = committedProcess?.generation.objectName;
    const referencedPayloads = new Set<string>(committedProcessObject ? [committedProcessObject] : []);
    const summaries: RuntimeJobStatusSummary[] = [];
    for (const object of statusObjects) {
      const body = await store.readText(object.objectName);
      if (body === null) throw new Error(`Runtime status disappeared during cleanup: ${object.objectName}`);
      const status = parseRuntimeJobStatus(JSON.parse(body) as unknown);
      if (status.raw.objectName.replace(/\/raw\.tar$/u, "/status.json") !== object.objectName) {
        throw new Error(`Runtime status path does not match its job id: ${object.objectName}`);
      }
      referencedPayloads.add(status.raw.objectName);
      if (status.stagedProcess) referencedPayloads.add(status.stagedProcess.objectName);
      summaries.push({
        objectName: object.objectName,
        state: status.state,
        updatedAt: status.updatedAt,
        ...(status.stagedProcess ? { stagedProcessObject: status.stagedProcess.objectName } : {}),
        ...(pendingObjectNames.has(pendingJobObjectName(status.jobId))
          ? { pendingMarkerObject: pendingJobObjectName(status.jobId) }
          : {}),
      });
    }
    const apply = args.get("apply") === "true";
    if (args.has("apply") && args.get("apply") !== "true" && args.get("apply") !== "false") {
      throw new Error("--apply must be true or false");
    }
    const orphanPayloads = jobObjects
      .filter((object) => /^times\/jobs\/[^/]+\/(?:raw\.tar|processed-[a-f0-9]{64}\.tar\.gz)$/u.test(object.objectName))
      .filter((object) => !referencedPayloads.has(object.objectName))
      .map((object) => {
        if (!object.uploadedAt) throw new Error(`Runtime orphan payload has no uploadedAt: ${object.objectName}`);
        return { objectName: object.objectName, uploadedAt: object.uploadedAt };
      });
    const plan = planRuntimeBucketCleanup(summaries, {
      now: new Date(),
      apply,
      ...(args.get("max-delete-jobs") ? { maxDeleteJobs: Number(args.get("max-delete-jobs")) } : {}),
      ...(committedProcessObject ? { protectedPayloadObjects: [committedProcessObject] } : {}),
    }, orphanPayloads);
    if (plan.mode === "apply") {
      const payloads = [...plan.jobs.flatMap((job) => job.objects.slice(0, -1)), ...plan.orphanObjects];
      const markers = plan.jobs.map((job) => job.objects.at(-1)!);
      // HF Bucket batch deletion is not transactional. Remove payloads first and
      // only hide their status markers after the payload phase has succeeded.
      await store.delete(payloads);
      await store.delete(markers);
    }
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  throw new Error(`Unsupported Runtime Bucket action: ${action}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
