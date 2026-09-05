import { afterEach, describe, expect, it, vi } from "vitest";
import { MaintenanceMonitor, type MonitorTick } from "../src/monitor-object";
import type { LoggedPing } from "../src/monitor-events";
import type { MonitorState } from "../src/monitor-policy";
import type { SchedulerEnv } from "../src/types";

const base = Date.parse("2026-09-05T04:00:00Z");
const uuid = "11111111-1111-4111-8111-111111111111";
let fixtureId = 0;
function fixture(slug = "times-capture") {
  const pings: LoggedPing[] = [];
  const bodies = new Map<number, string>();
  const stored = new Map<string, unknown>();
  const deliveries: Array<{ signal: string; payload: Record<string, unknown> }> = [];
  const faults = { body: false, list: false, delivery: false };
  let now = base;
  const addPing = (type: string, body: string, minute: number) => {
    const n = (pings.at(-1)?.n ?? 0) + 1;
    pings.push({ n, type, date: new Date(base + minute * 60_000).toISOString(), body_url: body ? "https://untrusted.example/do-not-follow" : null });
    bodies.set(n, body);
  };
  const add = (run: number, minute: number, outcome = "failure", attempt = 1, failureClass = "unknown") => addPing("log", [
    "monitor_event=v1", `task=${slug}`, `run_id=${run}`, `run_attempt=${attempt}`, `event_time=${new Date(base + minute * 60_000).toISOString()}`,
    `outcome=${outcome}`, `failure_class=${failureClass}`, `run=https://github.com/kargonerd/jojokanbao/actions/runs/${run}`,
  ].join("\n"), minute);
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === "https://healthchecks.io/api/v3/checks/") return Response.json({ ping_url: `https://hc-ping.com/${uuid}` });
    if (url.endsWith("/pings/")) return faults.list ? new Response("error", { status: 503 }) : Response.json({ pings: [...pings].reverse() });
    if (url.endsWith("/body")) {
      if (faults.body) return new Response("error", { status: 503 });
      const n = Number(url.split("/").at(-2));
      expect(url).toBe(`https://healthchecks.io/api/v3/checks/${uuid}/pings/${n}/body`);
      return new Response(bodies.get(n));
    }
    if (url.startsWith("https://hc-ping.com/")) {
      if (faults.delivery) return new Response("error", { status: 503 });
      const signal = url.endsWith("/fail") ? "fail" : "success";
      const payload = JSON.parse(String(init?.body));
      deliveries.push({ signal, payload });
      addPing(signal, JSON.stringify(payload), (now - base) / 60_000);
      return new Response("OK");
    }
    throw new Error(`Unexpected URL: ${url}`);
  }));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const context = { storage: {
    get: async (key: string) => structuredClone(stored.get(key)),
    put: async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); },
  } } as unknown as DurableObjectState;
  const env: SchedulerEnv = { GITHUB_TOKEN: "test", GITHUB_OWNER: "kargonerd", GITHUB_REPO: "jojokanbao", GITHUB_REF: "master", HEALTHCHECKS_API_KEY: `fixture-${++fixtureId}` };
  let actor = new MaintenanceMonitor(context, env);
  const tick = async (minute: number, extra: Partial<MonitorTick> = {}) => {
    now = base + minute * 60_000;
    return actor.fetch(new Request("https://monitor.internal/tick", { method: "POST", body: JSON.stringify({ slug, now, ...extra }) }));
  };
  return { add, addPing, tick, pings, bodies, faults, deliveries, stored,
    state: () => stored.get("monitor") as MonitorState,
    restart: () => { actor = new MaintenanceMonitor(context, env); },
  };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("durable monitor inbox", () => {
  it("survives restarts, deduplicates retries, and delivers one failure/recovery", async () => {
    const f = fixture();
    f.add(1, 1); f.add(1, 1);
    await f.tick(2);
    expect(f.state().executionFailures).toBe(1);
    expect(f.deliveries).toHaveLength(0);
    f.restart(); f.add(2, 3);
    await f.tick(4); await f.tick(5);
    expect(f.deliveries.map((entry) => entry.signal)).toEqual(["fail"]);
    f.add(3, 6, "success");
    await f.tick(7); await f.tick(8);
    expect(f.deliveries.map((entry) => entry.signal)).toEqual(["fail", "success"]);
    expect(f.state().executionFailures).toBe(0);
  });

  it("never produces an alarm/recovery pair for a single recovered failure", async () => {
    const f = fixture();
    f.add(1, 1); await f.tick(2);
    f.add(2, 3, "success"); await f.tick(4);
    expect(f.deliveries.map((entry) => entry.signal)).toEqual(["success"]);
  });

  it("persists a pending delivery before I/O and retries without recounting", async () => {
    const f = fixture();
    f.add(1, 1); f.add(2, 2); f.faults.delivery = true;
    await expect(f.tick(3)).rejects.toThrow("HTTP 503");
    expect(f.state().pending?.signal).toBe("fail");
    expect(f.state().cursor).toBe(2);
    f.restart(); f.faults.delivery = false;
    await f.tick(4); await f.tick(5);
    expect(f.state().executionFailures).toBe(2);
    expect(f.deliveries).toHaveLength(1);
  });

  it("replaces an undelivered alarm with a genuine recovery while catching up", async () => {
    const f = fixture();
    f.add(1, 1); f.add(2, 2); f.faults.delivery = true;
    await expect(f.tick(3)).rejects.toThrow();
    f.add(3, 4, "success"); f.faults.delivery = false;
    await f.tick(5);
    expect(f.deliveries.map((entry) => entry.signal)).toEqual(["success"]);
  });

  it("does not lose outcomes when downloading a body fails", async () => {
    const f = fixture();
    await f.tick(0);
    f.add(1, 1); f.faults.body = true;
    await expect(f.tick(2)).rejects.toThrow("HTTP 503");
    expect(f.state().cursor).toBe(0);
    f.faults.body = false; await f.tick(3);
    expect(f.state().executionFailures).toBe(1);
  });

  it("does not substitute an empty inbox for a read failure", async () => {
    const f = fixture();
    f.faults.list = true;
    await expect(f.tick(0)).rejects.toThrow("HTTP 503");
    expect(f.stored.has("monitor")).toBe(false);
    expect(f.deliveries).toHaveLength(0);
  });

  it("waits for the bounded backlog to be consumed before deciding", async () => {
    const f = fixture();
    f.add(1, 1); f.add(2, 2); f.add(3, 3, "success");
    await f.tick(4, { bodyBudget: 1 });
    await f.tick(5, { bodyBudget: 1 });
    expect(f.deliveries).toHaveLength(0);
    f.restart(); await f.tick(6, { bodyBudget: 1 });
    expect(f.deliveries.map((entry) => entry.signal)).toEqual(["success"]);
  });

  it("ignores start/log/no-op messages without extending the deadline", async () => {
    const f = fixture();
    f.add(1, 1, "success"); await f.tick(2);
    const deadline = f.state().deadlineAt;
    f.addPing("log", "task=times-capture\nstatus=running", 5);
    f.addPing("start", "", 10);
    await f.tick(11);
    expect(f.state().deadlineAt).toBe(deadline);
    expect(f.deliveries).toHaveLength(1);
  });

  it("supports the old workflow during a Worker-first rolling deployment", async () => {
    const f = fixture();
    f.addPing("success", "task=times-capture\nstatus=success\nrun=https://github.com/kargonerd/jojokanbao/actions/runs/1", 1);
    await f.tick(2);
    const firstDeadline = f.state().deadlineAt;
    f.addPing("success", "task=times-capture\nstatus=success\nrun=https://github.com/kargonerd/jojokanbao/actions/runs/2", 6);
    await f.tick(7);
    expect(f.state().deadlineAt).toBeGreaterThan(firstDeadline);
    expect(f.deliveries).toHaveLength(0);
  });

  it("reports inbox history loss, then recovers only with a real outcome", async () => {
    const f = fixture();
    await f.tick(0);
    f.addPing("log", "unrelated log", 1); f.pings[0]!.n = 101;
    f.bodies.set(101, "unrelated log");
    await f.tick(2);
    expect(f.deliveries).toMatchObject([{ signal: "fail", payload: { failureType: "monitoring-history-gap" } }]);
    f.add(1, 3, "success"); await f.tick(4);
    expect(f.deliveries.map((entry) => entry.signal)).toEqual(["fail", "success"]);
  });

  it("serializes overlapping ticks for the same task", async () => {
    const f = fixture();
    f.add(1, 1); f.add(2, 2);
    await Promise.all([f.tick(3), f.tick(3)]);
    expect(f.state().executionFailures).toBe(2);
    expect(f.deliveries).toHaveLength(1);
  });
  it("reconciles a history gap silently when a retained fresh success proves recovery", async () => {
    const f = fixture();
    await f.tick(0);
    f.add(1, 1, "success"); f.pings[0]!.n = 101;
    f.bodies.set(101, f.bodies.get(1)!);
    await f.tick(2);
    expect(f.deliveries.map((entry) => entry.signal)).toEqual(["success"]);
  });
});
