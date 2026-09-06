import { afterEach, describe, expect, it, vi } from "vitest";
import { MaintenanceMonitor, configuredMonitor } from "../src/monitor-object";
import { observeQueue, type QueueState } from "../src/queue-monitor";
import type { SchedulerEnv } from "../src/types";

const base = Date.parse("2026-09-06T02:00:00Z");
const uuid = "22222222-2222-4222-8222-222222222222";
const slug = "times-process-queue";
let counter = 0;
function fixture() {
  const env: SchedulerEnv = { GITHUB_TOKEN: "test", GITHUB_OWNER: "owner", GITHUB_REPO: "repo", GITHUB_REF: "master", HEALTHCHECKS_API_KEY: `queue-test-${++counter}` };
  const stored = new Map<string, unknown>();
  const deliveries: string[] = [];
  let runs: Array<{ id: number; status: string; created_at: string }> = [];
  const faults = { github: 0, delivery: false, malformed: false };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === "https://api.github.com") {
      expect(url.searchParams.get("per_page")).toBe("100");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.redirect).toBe("manual");
      if (faults.github) return new Response(null, { status: faults.github });
      if (faults.malformed) return Response.json({ total_count: 4 });
      const selected = url.pathname.includes("maintenance-times-process.yml") ? runs.filter((run) => run.status === url.searchParams.get("status")) : [];
      return Response.json({ total_count: selected.length, workflow_runs: selected });
    }
    if (url.href === "https://healthchecks.io/api/v3/checks/") {
      expect(JSON.parse(String(init?.body))).toMatchObject({ slug, schedule: "* * * * *", grace: 600, channels: "*" });
      return Response.json({ ping_url: `https://hc-ping.com/${uuid}` });
    }
    if (url.origin === "https://hc-ping.com") {
      if (faults.delivery) return new Response(null, { status: 503 });
      const signal = url.pathname.endsWith("/fail") ? "fail" : url.pathname.endsWith("/start") ? "start" : "success";
      // Durable decision must precede delivery.
      expect((stored.get("queue-monitor") as QueueState).pending).toBe(signal);
      deliveries.push(signal);
      return new Response("OK");
    }
    throw new Error(`Unexpected request (queue probes must not read business inboxes): ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const context = { storage: {
    get: async (key: string) => structuredClone(stored.get(key)),
    put: async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); },
  } } as unknown as DurableObjectState;
  let actor = new MaintenanceMonitor(context, env);
  return { env, fetcher, faults, deliveries, stored,
    setRuns: (count: number, createdMinute = 0, status = "pending") => {
      runs = Array.from({ length: count }, (_, id) => ({ id: id + 1, status, created_at: new Date(base + createdMinute * 60_000).toISOString() }));
    },
    state: () => stored.get("queue-monitor") as QueueState,
    restart: () => { actor = new MaintenanceMonitor(context, env); },
    tick: (minute: number) => actor.fetch(new Request("https://monitor.internal/tick", { method: "POST", body: JSON.stringify({ slug, now: base + minute * 60_000 }) })),
  };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("independent queue congestion monitor", () => {
  it("allows normal writer/admission waits and does not touch business state", async () => {
    const f = fixture(); f.setRuns(3);
    await f.tick(0); await f.tick(1);
    expect(f.deliveries).toEqual(["success", "success"]);
    expect(f.state().unhealthySince).toBeUndefined();
    expect(f.stored.has("monitor")).toBe(false);
  });

  it("debounces congestion across restart, alerts once and recovers on a fresh healthy probe", async () => {
    const f = fixture(); f.setRuns(100);
    await f.tick(0); await f.tick(4);
    expect(f.deliveries).toEqual(["start"]);
    f.restart(); await f.tick(5); await f.tick(6);
    expect(f.deliveries).toEqual(["start", "fail"]);
    expect(f.state().down).toBe(true);
    f.setRuns(1, 7); await f.tick(7);
    expect(f.deliveries).toEqual(["start", "fail", "success"]);
    expect(f.state().down).toBe(false);
  });

  it("does not alert for a transient queue burst", async () => {
    const f = fixture(); f.setRuns(4); await f.tick(0);
    f.setRuns(0); await f.tick(4);
    f.setRuns(4, 5); await f.tick(5); await f.tick(9);
    expect(f.deliveries).not.toContain("fail");
    expect(f.state().unhealthySince).toBe(base + 5 * 60_000);
  });

  it("detects a single old queued request even when the count is small", async () => {
    const f = fixture(); f.setRuns(1, -46, "queued");
    await f.tick(0); await f.tick(5);
    expect(f.deliveries).toEqual(["start", "fail"]);
  });

  it.each([302, 502, 403, 429])("never reports healthy when GitHub returns HTTP %s", async (status) => {
    const f = fixture(); f.faults.github = status;
    await expect(f.tick(0)).rejects.toThrow(`HTTP ${status}`);
    expect(f.deliveries).toEqual([]);
    expect(f.stored.size).toBe(0);
  });

  it("never reports healthy for a malformed queue response", async () => {
    const f = fixture(); f.faults.malformed = true;
    await expect(f.tick(0)).rejects.toThrow("Invalid queue response");
    expect(f.deliveries).toEqual([]);
  });

  it("persists failed delivery and retries it without another incident", async () => {
    const f = fixture(); f.setRuns(4); await f.tick(0);
    f.faults.delivery = true;
    await expect(f.tick(5)).rejects.toThrow("HTTP 503");
    expect(f.state().pending).toBe("fail");
    f.restart(); f.faults.delivery = false; await f.tick(6); await f.tick(7);
    expect(f.deliveries).toEqual(["start", "fail"]);
  });

  it("supersedes undelivered fail with recovery and rejects stale healthy ticks", async () => {
    const f = fixture(); f.setRuns(4); await f.tick(0);
    f.faults.delivery = true; await expect(f.tick(5)).rejects.toThrow();
    f.setRuns(0); f.faults.delivery = false;
    await f.tick(3);
    expect(f.state().down).toBe(true);
    await f.tick(6);
    expect(f.deliveries).toEqual(["start", "success"]);
  });

  it("deduplicates status transitions and bounds requests even above the API page size", async () => {
    const policy = configuredMonitor(slug).queue!;
    const f = fixture();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ total_count: 1000, workflow_runs: [
      { id: 1, status: "pending", created_at: new Date(base).toISOString() },
    ] }));
    expect(await observeQueue(policy, f.env, base, fetcher)).toMatchObject({ pendingRuns: 1000, congested: true });
    expect(fetcher).toHaveBeenCalledTimes(8);
    fetcher.mockImplementation(async () => Response.json({ total_count: 1, workflow_runs: [
      { id: 1, status: "pending", created_at: new Date(base).toISOString() },
    ] }));
    expect(await observeQueue(policy, f.env, base, fetcher)).toMatchObject({ pendingRuns: 1, congested: false });
  });
});
