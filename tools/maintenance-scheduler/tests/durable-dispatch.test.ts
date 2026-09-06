import { describe, expect, it, vi } from "vitest";
import { durableDispatch } from "../src/durable-dispatch";
import { scheduledTask } from "../src/tasks";
import { resolveScheduledSlot } from "../src/schedule";
import type { StateStore } from "../src/types";

const task = scheduledTask("rmrb-sync");
const now = Date.parse("2026-09-06T01:00:33.456Z");
const slot = resolveScheduledSlot(task, now)!;
const env = { GITHUB_TOKEN: "test", GITHUB_OWNER: "owner", GITHUB_REPO: "repo", GITHUB_REF: "master" };
function fixture(postStatus = 204) {
  const data = new Map<string, unknown>();
  const store: StateStore = { get: async <T>(key: string) => data.get(key) as T | undefined, put: async (key, value) => { data.set(key, value); } };
  const runs: unknown[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/dispatches")
    ? new Response(null, { status: postStatus }) : Response.json({ workflow_runs: runs }));
  const run = (at = now) => durableDispatch(store, task, env, { slot, observedAtMs: at, fetcher });
  return { run, runs, data, fetcher };
}
describe("durable delivery receipts", () => {
  it("does not double dispatch while an accepted run is invisible", async () => {
    const f = fixture(); await f.run();
    await expect(f.run(now + 60_000)).rejects.toThrow("unconfirmed");
    expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/dispatches"))).toHaveLength(1);
  });
  it("treats server errors as ambiguous, not safely retryable deliveries", async () => {
    const f = fixture(502); await expect(f.run()).rejects.toThrow("HTTP 502");
    await expect(f.run(now + 60_000)).rejects.toThrow("unconfirmed");
    expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/dispatches"))).toHaveLength(1);
  });
  it("permits the configured retry after reconciling a completed failed run", async () => {
    const f = fixture(); await f.run();
    f.runs.push({ display_title: task.automaticRunTitle, status: "completed", conclusion: "failure", created_at: "2026-09-06T01:00:33Z" });
    const result = await f.run(now + 16*60_000);
    expect(result).toMatchObject({ outcome: "dispatched", attempt: 2 });
  });
  it("blocks HTTP delivery when the durable pre-send write fails", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ workflow_runs: [] }));
    const store: StateStore = { get: async () => undefined, put: async () => { throw new Error("lease lost"); } };
    await expect(durableDispatch(store, task, env, { slot, observedAtMs: now, fetcher })).rejects.toThrow("lease lost");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
