import { afterEach, describe, expect, it, vi } from "vitest";
import { handleScheduled } from "../src/index";
import type { MonitorTick } from "../src/monitor-object";
import { scheduledTask } from "../src/tasks";
import type { SchedulerEnv } from "../src/types";

const env: SchedulerEnv = { GITHUB_TOKEN: "test", GITHUB_OWNER: "kargonerd", GITHUB_REPO: "jojokanbao", GITHUB_REF: "master", HEALTHCHECKS_API_KEY: "test-key" };
const controller = { scheduledTime: Date.parse("2026-09-05T01:20:00Z"), cron: "* * * * *" } as ScheduledController;
function fixture(status = 200) {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/runs?per_page=50")) return status !== 200 && url.includes("rmrb") ? new Response("upstream error", { status }) : Response.json({ workflow_runs: [] });
    if (url.endsWith("/dispatches")) return new Response(null, { status: 204 });
    if (url === "https://healthchecks.io/api/v3/checks/") return Response.json({ ping_url: `https://hc-ping.com/${JSON.parse(String(init?.body)).slug}` });
    if (url.startsWith("https://hc-ping.com/")) return new Response("OK");
    throw new Error(`Unexpected request: ${url}`);
  });
  return { fetcher, monitor: vi.fn<(tick: MonitorTick) => Promise<void>>().mockResolvedValue() };
}
afterEach(() => vi.restoreAllMocks());

describe("scheduler with shared alert policy", () => {
  it("keeps observing a daily monitor outside its catch-up window", async () => {
    const options = fixture();
    await handleScheduled({ ...controller, scheduledTime: Date.parse("2026-09-05T05:00:00Z") }, env, { ...options, tasks: [scheduledTask("rmrb-sync")] });
    expect(options.monitor).toHaveBeenCalledWith(expect.objectContaining({ slug: "rmrb-sync", dispatch: { kind: "idle" } }));
    expect(options.fetcher.mock.calls.some(([url]) => String(url).includes("api.github.com"))).toBe(false);
  });

  it("observes downstream stages without synthesizing success or resetting /start", async () => {
    const options = fixture();
    await handleScheduled(controller, env, { ...options, tasks: [scheduledTask("times-capture")] });
    expect(options.monitor.mock.calls.map(([tick]) => tick.slug)).toEqual(["times-capture", "times-process"]);
    expect(options.monitor).toHaveBeenCalledWith(expect.objectContaining({ slug: "times-capture", dispatch: { kind: "accepted" } }));
    const urls = options.fetcher.mock.calls.map(([url]) => String(url));
    expect(urls).toContain("https://hc-ping.com/maintenance-scheduler");
    expect(urls.some((url) => /\/(start|fail)$/u.test(url))).toBe(false);
  });

  it.each([[502, false], [403, true]])("isolates HTTP %s and passes permanent=%s to policy", async (status, permanent) => {
    const options = fixture(status);
    await handleScheduled(controller, env, options);
    expect(options.monitor).toHaveBeenCalledWith(expect.objectContaining({ slug: "rmrb-sync", dispatch: expect.objectContaining({ kind: "failed", permanent }) }));
    expect(options.monitor).toHaveBeenCalledWith(expect.objectContaining({ slug: "times-capture", dispatch: { kind: "accepted" } }));
    expect(options.fetcher.mock.calls.map(([url]) => String(url))).toContain("https://hc-ping.com/maintenance-scheduler");
  });

  it("does not keep the scheduler green when its policy consumer is broken", async () => {
    const options = fixture();
    options.monitor.mockRejectedValueOnce(new Error("inbox unavailable"));
    await handleScheduled(controller, env, options);
    const urls = options.fetcher.mock.calls.map(([url]) => String(url));
    expect(urls).toContain("https://hc-ping.com/maintenance-scheduler/log");
    expect(urls).not.toContain("https://hc-ping.com/maintenance-scheduler");
    expect(options.monitor).toHaveBeenCalledTimes(3);
  });
});
