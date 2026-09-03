import { afterEach, describe, expect, it, vi } from "vitest";

import { handleScheduled } from "../src/index";
import { scheduledTask } from "../src/tasks";
import type { SchedulerEnv } from "../src/types";

const env: SchedulerEnv = {
  GITHUB_TOKEN: "test-token",
  GITHUB_OWNER: "kargonerd",
  GITHUB_REPO: "jojokanbao",
  GITHUB_REF: "master",
  HEALTHCHECKS_TIMES_SCHEDULER_URL: "https://hc-ping.com/scheduler-id",
  HEALTHCHECKS_TIMES_PIPELINE_URL: "https://hc-ping.com/times-id",
  HEALTHCHECKS_RMRB_SYNC_URL: "https://hc-ping.com/rmrb-id",
};

const controller = {
  scheduledTime: Date.parse("2026-08-30T01:20:00.000Z"),
  cron: "* * * * *",
} as ScheduledController;

function requestUrl(input: RequestInfo | URL): string {
  return String(input);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleScheduled", () => {
  it("reports scheduler success and starts a dispatched task", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/runs?per_page=50")) {
        return Response.json({ workflow_runs: [] });
      }
      if (url.endsWith("/dispatches")) {
        return new Response(null, { status: 204 });
      }
      if (url.startsWith("https://hc-ping.com/")) {
        return new Response("OK");
      }
      return new Response("unexpected request", { status: 500 });
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await handleScheduled(controller, env, {
      fetcher,
      tasks: [scheduledTask("times-capture")],
    });

    const urls = fetcher.mock.calls.map(([input]) => requestUrl(input));
    expect(urls).toContain("https://hc-ping.com/scheduler-id");
    expect(urls).toContain("https://hc-ping.com/times-id/start");
  });

  it("isolates a task dispatch failure from other due tasks", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.includes("maintenance-sync-rmrb.yml/runs")) {
        return new Response("permission denied", { status: 403 });
      }
      if (url.endsWith("/runs?per_page=50")) {
        return Response.json({ workflow_runs: [] });
      }
      if (url.endsWith("/dispatches")) {
        return new Response(null, { status: 204 });
      }
      if (url.startsWith("https://hc-ping.com/")) {
        return new Response("OK");
      }
      return new Response("unexpected request", { status: 500 });
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(handleScheduled(controller, env, { fetcher })).resolves.toBeUndefined();

    const urls = fetcher.mock.calls.map(([input]) => requestUrl(input));
    expect(urls).toContain("https://hc-ping.com/times-id/start");
    expect(urls).toContain("https://hc-ping.com/rmrb-id/fail");
    expect(urls).toContain("https://hc-ping.com/scheduler-id");
  });
});
