import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchScheduledTask } from "../src/dispatch";
import { durableDispatch } from "../src/durable-dispatch";
import { handleScheduled } from "../src/index";
import { configuredMonitor, type MonitorTick } from "../src/monitor-object";
import { resolveScheduledSlot } from "../src/schedule";
import { scheduledTask } from "../src/tasks";
import { taskHealthcheck, taskStageHealthchecks, type StateStore } from "../src/types";

const task = scheduledTask("jojo-ai-availability");
const env = { GITHUB_TOKEN: "test", GITHUB_OWNER: "owner", GITHUB_REPO: "repo", GITHUB_REF: "master" };
const now = Date.parse("2026-09-08T00:18:33Z");
const slot = resolveScheduledSlot(task, now)!;

afterEach(() => vi.restoreAllMocks());

describe("AI availability scheduled task", () => {
  it("maps the existing monitor and workflow to one attempt per half-hour slot", () => {
    expect(task).toMatchObject({
      id: "jojo-ai-availability",
      cron: "17,47 * * * *",
      timeZone: "UTC",
      catchupWindowMinutes: 5,
      workflow: "monitor-ai.yml",
      automaticRunTitle: "AI availability [scheduler]",
      skipWhileWorkflowActive: true,
      maxAttempts: 1,
      retryDelayMinutes: 0,
    });
    expect(taskHealthcheck(task)).toMatchObject({
      slug: "jojo-ai-availability", schedule: "17,47 * * * *", timeZone: "UTC", graceSeconds: 1800,
    });
    expect(taskStageHealthchecks(task)).toEqual([]);
    expect(configuredMonitor(task.id)).toMatchObject({
      check: taskHealthcheck(task), policy: { executionFailures: 1 },
    });
  });

  it.each([
    ["2026-09-08T00:16:59.999Z", undefined],
    ["2026-09-08T00:17:00.000Z", "2026-09-08T00:17:00.000Z"],
    ["2026-09-08T00:21:59.999Z", "2026-09-08T00:17:00.000Z"],
    ["2026-09-08T00:22:00.000Z", undefined],
    ["2026-09-08T00:46:59.999Z", undefined],
    ["2026-09-08T00:47:00.000Z", "2026-09-08T00:47:00.000Z"],
    ["2026-09-08T00:51:59.999Z", "2026-09-08T00:47:00.000Z"],
    ["2026-09-08T00:52:00.000Z", undefined],
    ["2026-09-08T01:17:00.000Z", "2026-09-08T01:17:00.000Z"],
  ])("resolves %s within only the five-minute catch-up window", (observedAt, scheduledAt) => {
    expect(resolveScheduledSlot(task, Date.parse(observedAt))?.scheduledAt).toBe(scheduledAt);
  });

  it("sends the schedule identity rather than the later observation time", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ workflow_runs: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(dispatchScheduledTask(task, env, { fetcher, slot, observedAtMs: now }))
      .resolves.toMatchObject({ outcome: "dispatched", attempt: 1, workflow: "monitor-ai.yml" });
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://api.github.com/repos/owner/repo/actions/workflows/monitor-ai.yml/dispatches");
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      ref: "master",
      inputs: {
        automatic: "true",
        scheduled_at: "2026-09-08T00:17:00.000Z",
        schedule_slot: "jojo-ai-availability:2026-09-08T00:17:00.000Z",
      },
    });
  });

  it.each(["queued", "in_progress"])("does not dispatch while an AI workflow is %s", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ workflow_runs: [{ status }] }));
    await expect(dispatchScheduledTask(task, env, { fetcher, slot, observedAtMs: now }))
      .resolves.toMatchObject({ outcome: "skipped", reason: "active-workflows" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not rerun a failed automatic probe in the same slot", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ workflow_runs: [{
      status: "completed", conclusion: "failure", display_title: "AI availability [scheduler]",
      created_at: "2026-09-08T00:17:04Z",
    }] }));
    await expect(dispatchScheduledTask(task, env, { fetcher, slot, observedAtMs: now }))
      .resolves.toMatchObject({ outcome: "skipped", reason: "slot-already-dispatched", attempts: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses the durable receipt to prevent repeated dispatch before GitHub shows the run", async () => {
    const values = new Map<string, unknown>();
    const store: StateStore = {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key, value) => { values.set(key, value); },
    };
    const fetcher = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/dispatches")
      ? new Response(null, { status: 204 }) : Response.json({ workflow_runs: [] }));
    await durableDispatch(store, task, env, { fetcher, slot, observedAtMs: now });
    fetcher.mockRejectedValue(new Error("GitHub temporarily unavailable"));
    await expect(durableDispatch(store, task, env, { fetcher, slot, observedAtMs: now + 60_000 }))
      .resolves.toMatchObject({ outcome: "skipped", reason: "slot-already-dispatched" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/dispatches"))).toHaveLength(1);
  });

  it("still reconciles ambiguous receipts and permits a fresh slot after an accepted one", async () => {
    const values = new Map<string, unknown>([[task.id, { slot: slot.id, state: "sending", at: now }]]);
    const store: StateStore = {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key, value) => { values.set(key, value); },
    };
    const fetcher = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/dispatches")
      ? new Response(null, { status: 204 }) : Response.json({ workflow_runs: [] }));
    await expect(durableDispatch(store, task, env, { fetcher, slot, observedAtMs: now + 60_000 })).rejects.toThrow("unconfirmed");
    expect(fetcher).toHaveBeenCalledTimes(1);
    values.set(task.id, { slot: slot.id, state: "accepted", at: now });
    const next = now + 30 * 60_000;
    await expect(durableDispatch(store, task, env, { fetcher, slot: resolveScheduledSlot(task, next)!, observedAtMs: next }))
      .resolves.toMatchObject({ outcome: "dispatched", attempt: 1 });
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/dispatches"))).toHaveLength(1);
  });

  it("observes all six monitors concurrently even when the AI task is not due", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let finishMonitors!: () => void;
    const pending = new Promise<void>((resolve) => { finishMonitors = resolve; });
    const monitor = vi.fn<(tick: MonitorTick) => Promise<void>>().mockReturnValue(pending);
    const fetcher = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/dispatches")
      ? new Response(null, { status: 204 }) : Response.json({ workflow_runs: [] }));
    const tick = handleScheduled({ scheduledTime: Date.parse("2026-09-08T05:23:00Z"), cron: "* * * * *" }, env, { fetcher, monitor });
    await vi.waitFor(() => expect(monitor).toHaveBeenCalledTimes(6));
    expect(monitor).toHaveBeenCalledWith(expect.objectContaining({ slug: task.id, dispatch: { kind: "idle" }, bodyBudget: 8 }));
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("monitor-ai.yml"))).toBe(false);
    finishMonitors();
    await tick;
  });
});
