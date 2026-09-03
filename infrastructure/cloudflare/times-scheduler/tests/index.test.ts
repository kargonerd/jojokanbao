import { describe, expect, it, vi } from "vitest";

import type { SchedulerEnv } from "../src/dispatch";
import { handleScheduled } from "../src/index";

const env: SchedulerEnv = {
  GITHUB_TOKEN: "test-token",
  GITHUB_OWNER: "kargonerd",
  GITHUB_REPO: "jojokanbao",
  GITHUB_WORKFLOW: "maintenance-times-capture.yml",
  GITHUB_REF: "master",
  HEALTHCHECKS_TIMES_SCHEDULER_URL: "https://hc-ping.com/scheduler-id",
  HEALTHCHECKS_TIMES_PIPELINE_URL: "https://hc-ping.com/pipeline-id",
};

const controller = {
  scheduledTime: Date.parse("2026-08-30T01:20:00.000Z"),
  cron: "* * * * *",
} as ScheduledController;

function requestUrl(input: RequestInfo | URL): string {
  return String(input);
}

describe("handleScheduled", () => {
  it("reports scheduler success and starts the pipeline after dispatch", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/runs?per_page=10")) {
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

    await handleScheduled(controller, env, { fetcher });

    const urls = fetcher.mock.calls.map(([input]) => requestUrl(input));
    expect(urls).toContain("https://hc-ping.com/scheduler-id");
    expect(urls).toContain("https://hc-ping.com/pipeline-id/start");
  });

  it("reports scheduler failure when the GitHub API rejects the probe", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url === "https://hc-ping.com/scheduler-id/fail") {
        return new Response("OK");
      }
      return new Response("permission denied", { status: 403 });
    });

    await expect(handleScheduled(controller, env, { fetcher })).rejects.toThrow(
      "GitHub workflow activity check failed",
    );
    expect(fetcher.mock.calls.map(([input]) => requestUrl(input))).toContain(
      "https://hc-ping.com/scheduler-id/fail",
    );
  });
});
