import { describe, expect, it, vi } from "vitest";

import { DispatchError, dispatchScheduledTask } from "../src/dispatch";
import { resolveScheduledSlot } from "../src/schedule";
import { scheduledTask } from "../src/tasks";
import type { SchedulerEnv } from "../src/types";

const env: SchedulerEnv = {
  GITHUB_TOKEN: "test-token",
  GITHUB_OWNER: "kargonerd",
  GITHUB_REPO: "jojokanbao",
  GITHUB_REF: "master",
};

interface TestRun {
  status: string;
  conclusion?: string | null;
  created_at?: string;
  display_title?: string;
}

function workflowRuns(runs: TestRun[] = []): Response {
  return Response.json({ workflow_runs: runs });
}

function options(taskId: string, observedAt: string, fetcher: typeof fetch) {
  const observedAtMs = Date.parse(observedAt);
  const slot = resolveScheduledSlot(scheduledTask(taskId), observedAtMs);
  if (!slot) throw new Error("Expected task to be due in test");
  return { fetcher, observedAtMs, slot };
}

describe("dispatchScheduledTask", () => {
  it.each([
    [502, {}, "upstream error", false],
    [429, {}, "slow down", false],
    [403, { "x-ratelimit-remaining": "0" }, "rate limited", false],
    [403, { "retry-after": "60" }, "slow down", false],
    [403, {}, "secondary rate limit", false],
    [401, {}, "bad credentials", true],
    [403, {}, "permission denied", true],
    [404, {}, "missing workflow", true],
    [422, {}, "invalid inputs", true],
  ])("classifies HTTP %s %j as permanent=%s without treating rate limits as auth failures", async (status, headers, body, permanent) => {
    const task = scheduledTask("times-capture");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status, headers: headers as HeadersInit }));
    try {
      await dispatchScheduledTask(task, env, options(task.id, "2026-08-29T00:20:00Z", fetcher));
      expect.unreachable("expected dispatch failure");
    } catch (error) {
      expect(error).toBeInstanceOf(DispatchError);
      expect(error).toMatchObject({ permanent });
    }
  });
  it("bounds both GitHub requests without blindly retrying an ambiguous dispatch", async () => {
    const task = scheduledTask("times-capture");
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(workflowRuns())
        .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
      await expect(dispatchScheduledTask(task, env, options(task.id, "2026-08-29T00:20:00.000Z", fetcher)))
        .rejects.toThrow("timed out");
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(timeout.mock.calls).toEqual([[10_000], [10_000]]);
      for (const [, init] of fetcher.mock.calls) expect(init?.signal).toBeInstanceOf(AbortSignal);
    } finally { timeout.mockRestore(); }
  });

  it("fails closed when GitHub returns an invalid activity response", async () => {
    const task = scheduledTask("times-capture");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({}));
    await expect(dispatchScheduledTask(task, env, options(task.id, "2026-08-29T00:20:00.000Z", fetcher)))
      .rejects.toThrow("invalid runs");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("dispatches Times with its existing automatic inputs and schedule metadata", async () => {
    const task = scheduledTask("times-capture");
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(workflowRuns())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await dispatchScheduledTask(
      task,
      env,
      options(task.id, "2026-08-29T00:23:00.000Z", fetcher),
    );

    expect(result).toMatchObject({
      taskId: "times-capture",
      workflow: "maintenance-times-capture.yml",
      slotId: "times-capture:2026-08-29T00:20:00.000Z",
      slotStartedAt: "2026-08-29T00:20:00.000Z",
      outcome: "dispatched",
      attempt: 1,
    });
    const [url, init] = fetcher.mock.calls[1] ?? [];
    expect(url).toBe(
      "https://api.github.com/repos/kargonerd/jojokanbao/actions/workflows/maintenance-times-capture.yml/dispatches",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      ref: "master",
      inputs: {
        automatic: "true",
        publish: "true",
        scheduled_at: "2026-08-29T00:20:00.000Z",
        schedule_slot: "times-capture:2026-08-29T00:20:00.000Z",
        since_hours: "1",
        sources: "",
      },
    });
  });

  it("skips Times while its Capture workflow is active", async () => {
    const task = scheduledTask("times-capture");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(workflowRuns([
      { status: "in_progress" },
    ]));

    await expect(dispatchScheduledTask(
      task,
      env,
      options(task.id, "2026-08-29T00:20:00.000Z", fetcher),
    )).resolves.toMatchObject({
      outcome: "skipped",
      reason: "active-workflows",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not let a completed manual run consume an automatic slot", async () => {
    const task = scheduledTask("times-capture");
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(workflowRuns([{
        status: "completed",
        conclusion: "success",
        display_title: "Times capture [manual]",
        created_at: "2026-08-29T00:21:00Z",
      }]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(dispatchScheduledTask(
      task,
      env,
      options(task.id, "2026-08-29T00:23:00.000Z", fetcher),
    )).resolves.toMatchObject({ outcome: "dispatched" });
  });

  it("dispatches RMRB with an explicit Shanghai business date", async () => {
    const task = scheduledTask("rmrb-sync");
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(workflowRuns())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await dispatchScheduledTask(
      task,
      env,
      options(task.id, "2026-08-29T01:02:00.000Z", fetcher),
    );

    const [, init] = fetcher.mock.calls[1] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      ref: "master",
      inputs: {
        automatic: "true",
        date: "20260829",
        force: "false",
        scheduled_at: "2026-08-29T01:00:00.000Z",
        schedule_slot: "rmrb-sync:2026-08-29T01:00:00.000Z",
      },
    });
  });

  it("retries a failed RMRB run after the configured delay", async () => {
    const task = scheduledTask("rmrb-sync");
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(workflowRuns([{
        status: "completed",
        conclusion: "failure",
        display_title: "RMRB sync [cloudflare-cron]",
        created_at: "2026-08-29T01:01:00Z",
      }]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(dispatchScheduledTask(
      task,
      env,
      options(task.id, "2026-08-29T01:16:00.000Z", fetcher),
    )).resolves.toMatchObject({
      outcome: "dispatched",
      attempt: 2,
    });
  });

  it("does not retry a successful RMRB slot", async () => {
    const task = scheduledTask("rmrb-sync");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(workflowRuns([{
      status: "completed",
      conclusion: "success",
      display_title: "RMRB sync [cloudflare-cron]",
      created_at: "2026-08-29T01:01:00Z",
    }]));

    await expect(dispatchScheduledTask(
      task,
      env,
      options(task.id, "2026-08-29T01:30:00.000Z", fetcher),
    )).resolves.toMatchObject({
      outcome: "skipped",
      reason: "slot-already-dispatched",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
