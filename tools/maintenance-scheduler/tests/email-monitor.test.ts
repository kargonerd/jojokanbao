import { afterEach, describe, expect, it, vi } from "vitest";
import { EMAIL_BODY_LIMIT, parseEmailObservation, type EmailObservation } from "../src/email-events";
import type { EmailMonitorState } from "../src/email-policy";
import { readLoggedBody, type LoggedPing } from "../src/monitor-events";
import { TaskMonitor, type MonitorTick } from "../src/monitor-object";
import type { SchedulerEnv, StateStore } from "../src/types";

const base = Date.parse("2026-09-09T00:00:00Z");
const date = (minute: number) => new Date(base + minute * 60_000).toISOString();
const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
const checkId = uuid(999);
function event(run: number, minute: number, extra: Partial<EmailObservation> = {}): EmailObservation {
  return { mail_observation: "v1", task: "jojo-email-delivery", runId: String(run), runAttempt: "1", run: `https://github.com/owner/repo/actions/runs/${run}`,
    eventTime: date(minute), scanStart: date(minute - 1440), scanComplete: true, messages: [], transportProbe: { outcome: "not_run", at: date(minute) }, ...extra };
}
let fixtureId = 0;
function fixture() {
  const pings: LoggedPing[] = [];
  const bodies = new Map<number, string>();
  const saved = new Map<string, unknown>();
  const deliveries: string[] = [];
  const faults = { body: false, ping: false };
  let now = base;
  const add = (body: string, minute: number, type = "log") => {
    const n = (pings.at(-1)?.n ?? 0) + 1;
    pings.push({ n, type, date: date(minute), body_url: "https://untrusted.example/not-followed" });
    bodies.set(n, body);
  };
  const storage: StateStore = {
    get: async <T>(key: string) => structuredClone(saved.get(key)) as T | undefined,
    put: async (key, value) => { saved.set(key, structuredClone(value)); },
  };
  const env: SchedulerEnv = { GITHUB_TOKEN: "test", GITHUB_OWNER: "owner", GITHUB_REPO: "repo", GITHUB_REF: "master", HEALTHCHECKS_API_KEY: `email-fixture-${++fixtureId}` };
  let actor = new TaskMonitor({ storage }, env);
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, options) => {
    const url = String(input);
    if (url === "https://healthchecks.io/api/v3/checks/") return Response.json({ ping_url: `https://hc-ping.com/${checkId}` });
    if (url.endsWith("/pings/")) return Response.json({ pings: [...pings].reverse() });
    if (url.endsWith("/body")) {
      if (faults.body) return new Response("error", { status: 503 });
      const n = Number(url.split("/").at(-2));
      expect(url).toBe(`https://healthchecks.io/api/v3/checks/${checkId}/pings/${n}/body`);
      return new Response(bodies.get(n));
    }
    expect([`https://hc-ping.com/${checkId}`, `https://hc-ping.com/${checkId}/fail`]).toContain(url);
    if (faults.ping) return new Response("error", { status: 503 });
    const signal = url.endsWith("/fail") ? "fail" : "success";
    deliveries.push(signal);
    add(String(options?.body), (now - base) / 60_000, signal);
    return new Response("OK");
  }));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  return { add, pings, bodies, faults, deliveries, saved,
    state: () => saved.get("monitor") as EmailMonitorState,
    restart: () => { actor = new TaskMonitor({ storage }, env); },
    tick: (minute: number, extra: Partial<MonitorTick> = {}) => {
      now = base + minute * 60_000;
      return actor.tick({ slug: "jojo-email-delivery", now, ...extra });
    },
  };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("strict email observation protocol", () => {
  it.each([
    { task: "jojo-ai-availability" }, { runId: "0" }, { runAttempt: "1\n" },
    { run: "https://github.com/owner/repo/actions/runs/2" }, { eventTime: date(10) },
    { scanStart: date(2) }, { scanComplete: false }, { scanError: "unexpected" },
    { transportProbe: { outcome: "not_run" } }, { transportProbe: { outcome: "not_run", at: date(1), reason: "unexpected" } },
    { transportProbe: { outcome: "success", at: date(1) } },
    { transportProbe: { outcome: "failure", at: date(1), reason: "private@email.example" } },
    { messages: [{ id: uuid(1), createdAt: date(0), status: "unknown" }] },
    { messages: [{ id: uuid(1), createdAt: date(0), status: "delivered", recipient: "private@email.example" }] },
  ])("rejects malformed or private observation fields %j", (extra) => {
    expect(() => parseEmailObservation(JSON.stringify({ ...event(1, 1), ...extra }), base + 2 * 60_000)).toThrow("Invalid email");
  });
  it("rejects duplicate provider IDs and over-capacity envelopes", () => {
    const message = { id: uuid(1), createdAt: date(0), status: "delivered" as const };
    expect(() => parseEmailObservation(JSON.stringify(event(1, 1, { messages: [message, message] })), base + 2 * 60_000)).toThrow();
    expect(() => parseEmailObservation(JSON.stringify(event(1, 1, { messages: Array.from({ length: 201 }, (_, index) => ({ ...message, id: uuid(index + 1) })) })), base + 2 * 60_000)).toThrow();
  });
  it("reads the bounded larger mail body without increasing the generic protocol limit", async () => {
    const body = JSON.stringify(event(1, 1, { messages: Array.from({ length: 200 }, (_, index) => ({ id: uuid(index + 1), createdAt: date(0), status: "delivered" })) }));
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(8192);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(body));
    await expect(readLoggedBody(checkId, 1, "key", fetcher)).rejects.toThrow("too large");
    expect(parseEmailObservation(await readLoggedBody(checkId, 1, "key", fetcher, EMAIL_BODY_LIMIT), base + 2 * 60_000).messages).toHaveLength(200);
    fetcher.mockResolvedValueOnce(new Response("x".repeat(EMAIL_BODY_LIMIT + 1)));
    await expect(readLoggedBody(checkId, 1, "key", fetcher, EMAIL_BODY_LIMIT)).rejects.toThrow("too large");
  });
});

describe("email inbox and durable delivery", () => {
  it.each([
    { slot: 218, failed: 222, alarm: 227, next: 233 },
    { slot: 293, failed: 297, alarm: 302, next: 309 },
  ])("does not alarm after a completed slot's state-read failure at minute $failed", async ({ slot, failed, alarm, next }) => {
    const f = fixture();
    f.add(JSON.stringify(event(1, slot + 0.5, {
      transportProbe: { outcome: "success", at: date(slot + 0.5), messageId: uuid(900) },
    })), slot + 0.5);
    await f.tick(slot + 1, { expectedAt: base + slot * 60_000 });
    expect(f.deliveries).toEqual(["success"]);
    await f.tick(failed, { expectedAt: base + slot * 60_000,
      dispatch: { kind: "failed", permanent: false, reason: "Scheduler state get: HTTP 504" } });
    f.restart();
    await f.tick(alarm);
    expect(f.state().dispatch.failure).toBeUndefined();
    expect(f.state().down).toBe(false);
    expect(f.deliveries).toEqual(["success"]);
    f.add(JSON.stringify(event(2, next + 0.5)), next + 0.5);
    await f.tick(next + 1);
    expect(f.deliveries).toEqual(["success", "success"]);
  });

  it("starts unknown, recovers only from a real SMTP observation, deduplicates replay and does not echo decisions", async () => {
    const f = fixture();
    f.add(JSON.stringify(event(1, 1)), 1);
    await f.tick(2);
    expect(f.state().status).toBe("unknown");
    expect(f.deliveries).toEqual([]);
    const success = event(2, 3, { transportProbe: { outcome: "success", at: date(3), messageId: uuid(900) } });
    f.add(JSON.stringify(success), 3);
    await f.tick(4);
    expect(f.deliveries).toEqual(["success"]);
    f.restart();
    f.add(JSON.stringify(success), 5);
    await f.tick(6);
    expect(f.deliveries).toEqual(["success"]);
    expect(f.state().transport.lastSuccessAt).toBe(base + 3 * 60_000);
  });
  it("persists a pending failure before delivery and retries once without consuming new outcomes", async () => {
    const f = fixture();
    f.add(JSON.stringify(event(1, 1, { scanComplete: false, scanError: "resend_http_503" })), 1);
    f.faults.ping = true;
    await expect(f.tick(2)).rejects.toThrow("HTTP 503");
    expect(f.state()).toMatchObject({ cursor: 1, down: true, pending: { signal: "fail" } });
    f.restart(); f.faults.ping = false;
    await f.tick(3); await f.tick(4);
    expect(f.deliveries).toEqual(["fail"]);
    expect(f.state().seen).toEqual(["1:1"]);
  });
  it("does not advance a cursor past a malformed log or a failed body read", async () => {
    const f = fixture();
    await f.tick(0);
    f.add("{\"mail_observation\":", 1);
    await expect(f.tick(2)).rejects.toThrow("Invalid email");
    expect(f.state().cursor).toBe(0);
    f.bodies.set(1, JSON.stringify(event(1, 1)));
    f.faults.body = true;
    await expect(f.tick(3)).rejects.toThrow("HTTP 503");
    expect(f.state().cursor).toBe(0);
    f.faults.body = false;
    await f.tick(4);
    expect(f.state().cursor).toBe(1);
  });
  it("consumes the complete bounded backlog before emitting failure/recovery transitions", async () => {
    const f = fixture();
    f.add(JSON.stringify(event(1, 1, { transportProbe: { outcome: "failure", at: date(1), reason: "recover_http_500" } })), 1);
    f.add(JSON.stringify(event(2, 2, { transportProbe: { outcome: "success", at: date(2), messageId: uuid(900) } })), 2);
    await f.tick(3, { bodyBudget: 1 });
    expect(f.deliveries).toEqual([]);
    f.restart(); await f.tick(4, { bodyBudget: 1 });
    expect(f.deliveries).toEqual(["success"]);
  });
  it("detects a missed workflow even before the first SMTP proof", async () => {
    const f = fixture();
    await f.tick(8, { expectedAt: base + 8 * 60_000 });
    expect(f.deliveries).toEqual([]);
    await f.tick(28);
    expect(f.deliveries).toEqual(["fail"]);
  });
  it("does not clear history loss with an empty scan and waits for a fresh transport proof", async () => {
    const f = fixture();
    f.add(JSON.stringify(event(1, 1, { transportProbe: { outcome: "success", at: date(1), messageId: uuid(900) } })), 1);
    await f.tick(2);
    f.pings.splice(0);
    f.add(JSON.stringify(event(2, 3)), 3);
    f.pings[0]!.n = 100;
    f.bodies.set(100, JSON.stringify(event(2, 3)));
    await f.tick(4);
    expect(f.state().down).toBe(true);
    f.add(JSON.stringify(event(3, 5, { transportProbe: { outcome: "success", at: date(5), messageId: uuid(901) } })), 5);
    await f.tick(6);
    expect(f.state().down).toBe(false);
    expect(f.deliveries).toEqual(["success", "fail", "success"]);
  });
});
