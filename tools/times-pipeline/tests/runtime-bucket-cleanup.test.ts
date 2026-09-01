import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_CLEANUP_MAX_JOBS,
  planRuntimeBucketCleanup,
  type RuntimeJobStatusSummary,
} from "../src/runtime-bucket/cleanup.js";

const NOW = new Date("2026-09-01T00:00:00.000Z");
const GENERATION_A = `times/jobs/staged-old/processed-${"a".repeat(64)}.tar.gz`;
const GENERATION_B = `times/jobs/orphan-old/processed-${"b".repeat(64)}.tar.gz`;

function summary(
  jobId: string,
  state: RuntimeJobStatusSummary["state"],
  updatedAt: string,
): RuntimeJobStatusSummary {
  return {
    objectName: `times/jobs/${jobId}/status.json`,
    state,
    updatedAt,
  };
}

describe("Runtime Bucket retention cleanup", () => {
  it("deletes done jobs only after 14 days and lists payload before status", () => {
    const plan = planRuntimeBucketCleanup([
      summary("done-old", "done", "2026-08-17T23:59:59.999Z"),
      summary("done-boundary", "done", "2026-08-18T00:00:00.000Z"),
      summary("done-recent", "done", "2026-08-31T00:00:00.000Z"),
    ], { now: NOW });

    expect(plan).toEqual({
      mode: "dry-run",
      jobs: [{
        jobId: "done-old",
        state: "done",
        updatedAt: "2026-08-17T23:59:59.999Z",
        retentionDays: 14,
        requiresAlert: false,
        objects: [
          "times/jobs/done-old/raw.tar",
          "times/jobs/done-old/status.json",
        ],
      }],
      objects: [
        "times/jobs/done-old/raw.tar",
        "times/jobs/done-old/status.json",
      ],
      orphanObjects: [],
    });
  });

  it("deletes stale ready and partial jobs after 30 days and marks both for alerting", () => {
    const plan = planRuntimeBucketCleanup([
      summary("partial-old", "partial", "2026-07-31T23:59:59.999Z"),
      summary("ready-old", "ready", "2026-07-01T00:00:00.000Z"),
      summary("partial-boundary", "partial", "2026-08-02T00:00:00.000Z"),
    ], { now: NOW, apply: true });

    expect(plan.mode).toBe("apply");
    expect(plan.jobs).toEqual([
      expect.objectContaining({ jobId: "partial-old", state: "partial", retentionDays: 30, requiresAlert: true }),
      expect.objectContaining({ jobId: "ready-old", state: "ready", retentionDays: 30, requiresAlert: true }),
    ]);
    expect(plan.objects).toEqual([
      "times/jobs/partial-old/raw.tar",
      "times/jobs/partial-old/status.json",
      "times/jobs/ready-old/raw.tar",
      "times/jobs/ready-old/status.json",
    ]);
  });

  it("deletes an uncommitted Process payload before its job marker", () => {
    const plan = planRuntimeBucketCleanup([{
      ...summary("staged-old", "ready", "2026-07-01T00:00:00.000Z"),
      stagedProcessObject: GENERATION_A,
    }], { now: NOW, apply: true });
    expect(plan.objects).toEqual([
      "times/jobs/staged-old/raw.tar",
      GENERATION_A,
      "times/jobs/staged-old/status.json",
    ]);
    expect(() => planRuntimeBucketCleanup([{
      ...summary("staged-old", "ready", "2026-07-01T00:00:00.000Z"),
      stagedProcessObject: `times/jobs/other/processed-${"a".repeat(64)}.tar.gz`,
    }], { now: NOW })).toThrow("Unsafe Runtime staged Process object");
  });

  it("cleans only orphan payloads older than 30 days", () => {
    const plan = planRuntimeBucketCleanup([], { now: NOW, apply: true }, [
      { objectName: "times/jobs/orphan-old/raw.tar", uploadedAt: "2026-07-01T00:00:00.000Z" },
      { objectName: GENERATION_B, uploadedAt: "2026-07-02T00:00:00.000Z" },
      { objectName: "times/jobs/orphan-new/raw.tar", uploadedAt: "2026-08-31T00:00:00.000Z" },
    ]);
    expect(plan.jobs).toEqual([]);
    expect(plan.orphanObjects).toEqual([
      GENERATION_B,
      "times/jobs/orphan-old/raw.tar",
    ]);
    expect(plan.objects).toEqual(plan.orphanObjects);
    expect(() => planRuntimeBucketCleanup([], { now: NOW }, [{
      objectName: "times/jobs/orphan/status.json",
      uploadedAt: "2026-07-01T00:00:00.000Z",
    }])).toThrow("Unsafe Runtime orphan payload object");
  });

  it("never deletes the committed generation, including from a stale staged job or orphan scan", () => {
    const plan = planRuntimeBucketCleanup([{
      ...summary("staged-old", "ready", "2026-07-01T00:00:00.000Z"),
      stagedProcessObject: GENERATION_A,
    }], {
      now: NOW,
      apply: true,
      protectedPayloadObjects: [GENERATION_A],
    }, [
      { objectName: GENERATION_A, uploadedAt: "2026-07-01T00:00:00.000Z" },
      { objectName: GENERATION_B, uploadedAt: "2026-07-01T00:00:00.000Z" },
    ]);

    expect(plan.objects).not.toContain(GENERATION_A);
    expect(plan.objects).toContain(GENERATION_B);
    expect(plan.jobs[0]?.objects).toEqual([
      "times/jobs/staged-old/raw.tar",
      "times/jobs/staged-old/status.json",
    ]);
  });

  it("defaults to dry-run and requires an explicit apply opt-in without changing the plan", () => {
    const rows = [summary("old", "done", "2026-08-01T00:00:00.000Z")];
    const dryRun = planRuntimeBucketCleanup(rows, { now: NOW });
    const apply = planRuntimeBucketCleanup(rows, { now: NOW, apply: true });

    expect(dryRun.mode).toBe("dry-run");
    expect(apply.mode).toBe("apply");
    expect(apply.jobs).toEqual(dryRun.jobs);
    expect(apply.objects).toEqual(dryRun.objects);
  });

  it("sorts jobs deterministically regardless of Bucket listing order", () => {
    const plan = planRuntimeBucketCleanup([
      summary("z-job", "done", "2026-08-01T00:00:00.000Z"),
      summary("a_job", "done", "2026-08-01T00:00:00.000Z"),
    ], { now: NOW });

    expect(plan.jobs.map((job) => job.jobId)).toEqual(["a_job", "z-job"]);
  });

  it.each([
    "jobs/id/status.json",
    "times/jobs/../status.json",
    "times/jobs/id/../../status.json",
    "times/jobs/id/nested/status.json",
    "times/jobs/id/raw.tar",
    "times/jobs/id/other.json",
    "times\\jobs\\id\\status.json",
    "times/jobs/id.with-dot/status.json",
    "times/jobs/id%2Fescape/status.json",
  ])("rejects an unsafe or non-status object path: %s", (objectName) => {
    expect(() => planRuntimeBucketCleanup([{
      objectName,
      state: "done",
      updatedAt: "2026-08-01T00:00:00.000Z",
    }], { now: NOW })).toThrow("Unsafe Runtime job status object");
  });

  it("rejects duplicate jobs, invalid status data and invalid options", () => {
    const old = summary("duplicate", "done", "2026-08-01T00:00:00.000Z");
    expect(() => planRuntimeBucketCleanup([old, old], { now: NOW })).toThrow("Duplicate Runtime job status");
    expect(() => planRuntimeBucketCleanup([{
      ...old,
      state: "running",
    } as unknown as RuntimeJobStatusSummary], { now: NOW })).toThrow("invalid state");
    expect(() => planRuntimeBucketCleanup([{
      ...old,
      updatedAt: "not-a-date",
    }], { now: NOW })).toThrow("invalid updatedAt");
    expect(() => planRuntimeBucketCleanup([], { now: new Date(Number.NaN) })).toThrow("now must be a valid Date");
    expect(() => planRuntimeBucketCleanup([], {
      now: NOW,
      apply: "yes" as unknown as boolean,
    })).toThrow("apply must be a boolean");
    expect(() => planRuntimeBucketCleanup([], { now: NOW, maxDeleteJobs: 0 })).toThrow("positive integer");
  });

  it("fails closed when eligible jobs exceed the configured deletion limit", () => {
    expect(DEFAULT_RUNTIME_CLEANUP_MAX_JOBS).toBe(100);
    expect(() => planRuntimeBucketCleanup([
      summary("one", "done", "2026-08-01T00:00:00.000Z"),
      summary("two", "done", "2026-08-01T00:00:00.000Z"),
    ], { now: NOW, maxDeleteJobs: 1 })).toThrow(
      "Runtime cleanup would delete 2 jobs, exceeding maxDeleteJobs 1",
    );

    const overDefaultLimit = Array.from({ length: 101 }, (_, index) => (
      summary(`job-${index}`, "done", "2026-08-01T00:00:00.000Z")
    ));
    expect(() => planRuntimeBucketCleanup(overDefaultLimit, { now: NOW })).toThrow(
      "Runtime cleanup would delete 101 jobs, exceeding maxDeleteJobs 100",
    );
    expect(planRuntimeBucketCleanup(overDefaultLimit, {
      now: NOW,
      maxDeleteJobs: 101,
    }).jobs).toHaveLength(101);
  });
});
