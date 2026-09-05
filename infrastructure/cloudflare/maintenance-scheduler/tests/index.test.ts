import { afterEach, describe, expect, it, vi } from "vitest";

import { handleScheduled } from "../src/index";
import { scheduledTask } from "../src/tasks";
import type { SchedulerEnv } from "../src/types";

const env: SchedulerEnv = {
  GITHUB_TOKEN: "test-token",
  GITHUB_OWNER: "kargonerd",
  GITHUB_REPO: "jojokanbao",
  GITHUB_REF: "master",
  HEALTHCHECKS_API_KEY: "management-api-key",
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
  it("provisions a configured task even when it is not due", async () => {
    const provisioned: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url === "https://healthchecks.io/api/v3/checks/") {
        const body = JSON.parse(String(init?.body)) as { slug: string };
        provisioned.push(body.slug);
        return Response.json({ ping_url: `https://hc-ping.com/${body.slug}` });
      }
      if (url.startsWith("https://hc-ping.com/")) {
        return new Response("OK");
      }
      return new Response("unexpected request", { status: 500 });
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await handleScheduled({
      scheduledTime: Date.parse("2026-08-30T05:00:00.000Z"),
      cron: "* * * * *",
    } as ScheduledController, env, {
      fetcher,
      tasks: [scheduledTask("rmrb-sync")],
    });

    expect(provisioned).toEqual(expect.arrayContaining([
      "rmrb-sync",
      "maintenance-scheduler",
    ]));
    const urls = fetcher.mock.calls.map(([input]) => requestUrl(input));
    expect(urls).not.toContain("https://hc-ping.com/rmrb-sync");
    expect(urls).toContain("https://hc-ping.com/maintenance-scheduler");
  });

  it("reports scheduler success and starts a dispatched task", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/runs?per_page=50")) {
        return Response.json({ workflow_runs: [] });
      }
      if (url.endsWith("/dispatches")) {
        return new Response(null, { status: 204 });
      }
      if (url === "https://healthchecks.io/api/v3/checks/") {
        const body = JSON.parse(String(init?.body)) as { slug: string };
        return Response.json({ ping_url: `https://hc-ping.com/${body.slug}` });
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
    expect(urls).toContain("https://hc-ping.com/maintenance-scheduler");
    expect(urls).toContain("https://hc-ping.com/times-capture/start");
    expect(fetcher.mock.calls.some(([input, init]) =>
      String(input) === "https://healthchecks.io/api/v3/checks/" &&
      JSON.parse(String(init?.body)).slug === "times-process")).toBe(true);
    expect(urls).not.toContain("https://hc-ping.com/times-process");
    expect(urls).not.toContain("https://hc-ping.com/times-process/start");
  });

  it("isolates a task dispatch failure from other due tasks", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
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
      if (url === "https://healthchecks.io/api/v3/checks/") {
        const body = JSON.parse(String(init?.body)) as { slug: string };
        return Response.json({ ping_url: `https://hc-ping.com/${body.slug}` });
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
    expect(urls).toContain("https://hc-ping.com/times-capture/start");
    expect(urls).toContain("https://hc-ping.com/rmrb-sync/fail");
    expect(urls).toContain("https://hc-ping.com/maintenance-scheduler");
  });
});
