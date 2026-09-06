import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeQueue, tickQueueMonitor } from "../src/queue-monitor";
import type { QueuePolicy, SchedulerEnv } from "../src/types";

const now = Date.parse("2026-09-06T11:18:20.289Z");
const env: SchedulerEnv = { GITHUB_OWNER: "owner", GITHUB_REPO: "repo", GITHUB_REF: "master", GITHUB_TOKEN: "never-log-this-token" };
const policy: QueuePolicy = { workflows: ["maintenance-times-process.yml", "maintenance-times-runtime-cleanup.yml"],
  maxPendingRuns: 3, maxWaitSeconds: 2700, failureSeconds: 300 };
const run = { id: 34029851922, status: "pending", created_at: "2026-09-06T11:18:18Z" };
const empty = { total_count: 0, workflow_runs: [] };

function fixture(snapshots: unknown[]) {
  let attempts = 0;
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("maintenance-times-process.yml")) {
      if (url.searchParams.get("status") === "queued") return Response.json(snapshots[Math.min(attempts++, snapshots.length - 1)], {
        headers: { "x-github-request-id": "F8DC:0C1B:9F28BE:D61E3B:6A9D4BF9" },
      });
      if (url.searchParams.get("status") === "pending") return Response.json({ total_count: 1, workflow_runs: [run] });
    }
    return Response.json(empty);
  });
  return { fetcher, attempts: () => attempts };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("bounded GitHub queue snapshot retries", () => {
  it("re-reads the captured count/list mismatch and retains a concurrent pending run", async () => {
    const f = fixture([{ total_count: 1, workflow_runs: [] }, empty]);
    const result = observeQueue(policy, env, now, f.fetcher);
    await vi.advanceTimersByTimeAsync(499);
    expect(f.attempts()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ pendingRuns: 1, oldestWaitSeconds: 2.289, congested: false });
    expect(f.fetcher).toHaveBeenCalledTimes(9); // Only the inconsistent status is retried.
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"runCount":0'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"requestId":"F8DC:'));
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(env.GITHUB_TOKEN);
  });

  it("retries a count smaller than the returned list and deduplicates the fresh snapshot", async () => {
    const f = fixture([{ total_count: 0, workflow_runs: [run] }, { total_count: 1, workflow_runs: [run] }]);
    const result = observeQueue(policy, env, now, f.fetcher);
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toMatchObject({ pendingRuns: 1, congested: false });
  });

  it("allows a second delayed re-read without inflating counts from discarded snapshots", async () => {
    const f = fixture([{ total_count: 100, workflow_runs: [] }, { total_count: 1, workflow_runs: [] }, empty]);
    const result = observeQueue(policy, env, now, f.fetcher);
    await vi.advanceTimersByTimeAsync(1999);
    expect(f.attempts()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ pendingRuns: 1, congested: false });
    expect(f.fetcher).toHaveBeenCalledTimes(10);
  });

  it("fails closed after three inconsistent snapshots without state changes or recovery pings", async () => {
    const f = fixture([{ total_count: 1, workflow_runs: [] }]);
    vi.stubGlobal("fetch", f.fetcher);
    const storage = { get: vi.fn(async () => undefined), put: vi.fn() };
    const result = tickQueueMonitor(storage, env, policy, "times-process-queue", "https://hc-ping.com/test", "check", now);
    const rejected = expect(result).rejects.toThrow('"attempt":3,"totalCount":1,"runCount":0');
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    expect(f.attempts()).toBe(3);
    expect(f.fetcher).toHaveBeenCalledTimes(10);
    expect(storage.put).not.toHaveBeenCalled();
    expect(f.fetcher.mock.calls.every(([url]) => new URL(String(url)).origin === "https://api.github.com")).toBe(true);
  });

  it.each([null, {}, { total_count: -1, workflow_runs: [] }, { total_count: 1 }, { total_count: "1", workflow_runs: [] }])(
    "does not retry structurally invalid payload %j", async (payload) => {
      const f = fixture([payload]);
      await expect(observeQueue(policy, env, now, f.fetcher)).rejects.toThrow("Invalid queue response");
      expect(f.attempts()).toBe(1);
      expect(console.warn).not.toHaveBeenCalled();
    },
  );

  it("never multiplies the original 10-second timeout across retries", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      setTimeout(() => controller.abort(new Error("probe budget exhausted")), ms);
      return controller.signal;
    });
    let attempt = 0;
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      signals.push(init!.signal!);
      if (attempt++ < 8) {
        await new Promise((resolve) => setTimeout(resolve, 9000));
        return Response.json({ total_count: 1, workflow_runs: [] });
      }
      return new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
    });
    const rejected = expect(observeQueue(policy, env, now, fetcher)).rejects.toThrow("probe budget exhausted");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(AbortSignal.timeout).toHaveBeenCalledExactlyOnceWith(10_000);
    expect(new Set(signals).size).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(16);
    expect(vi.getTimerCount()).toBe(0);
  });
});
