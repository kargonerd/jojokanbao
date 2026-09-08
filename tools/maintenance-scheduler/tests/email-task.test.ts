import { describe, expect, it, vi } from "vitest";
import { dispatchScheduledTask } from "../src/dispatch";
import { resolveScheduledSlot } from "../src/schedule";
import { scheduledTask } from "../src/tasks";
import { taskHealthcheck } from "../src/types";

const task = scheduledTask("jojo-email-delivery");
const env = { GITHUB_TOKEN: "test", GITHUB_OWNER: "owner", GITHUB_REPO: "repo", GITHUB_REF: "master" };
describe("email scheduled task", () => {
  it("uses the existing scheduler, a single attempt, and an independent healthcheck", () => {
    expect(task).toMatchObject({ cron: "8,23,38,53 * * * *", timeZone: "UTC", catchupWindowMinutes: 5, workflow: "monitor-email.yml", automaticRunTitle: "Email delivery [scheduler]", skipWhileWorkflowActive: true, maxAttempts: 1, retryDelayMinutes: 0 });
    expect(taskHealthcheck(task)).toMatchObject({ slug: "jojo-email-delivery", graceSeconds: 1200 });
  });
  it.each([[7, undefined], [8, 8], [12, 8], [13, undefined], [23, 23], [38, 38], [53, 53], [58, undefined]])("resolves minute %s to its bounded slot", (minute, scheduled) => {
    const slot = resolveScheduledSlot(task, Date.UTC(2026, 8, 9, 0, minute!));
    expect(slot?.scheduledAtMs).toBe(scheduled === undefined ? undefined : Date.UTC(2026, 8, 9, 0, scheduled));
  });
  it("passes the canonical natural slot to the workflow without forcing another transport verification", async () => {
    const now = Date.parse("2026-09-09T04:09:20Z");
    const slot = resolveScheduledSlot(task, now)!;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ workflow_runs: [] })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await dispatchScheduledTask(task, env, { fetcher, slot, observedAtMs: now });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ ref: "master", inputs: {
      automatic: "true", scheduled_at: "2026-09-09T04:08:00.000Z", schedule_slot: "jojo-email-delivery:2026-09-09T04:08:00.000Z",
    } });
  });
  it.each(["queued", "in_progress"])("does not duplicate an already %s email workflow", async (status) => {
    const now = Date.parse("2026-09-09T00:08:00Z");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ workflow_runs: [{ status }] }));
    await expect(dispatchScheduledTask(task, env, { fetcher, slot: resolveScheduledSlot(task, now)!, observedAtMs: now })).resolves.toMatchObject({ outcome: "skipped", reason: "active-workflows" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
