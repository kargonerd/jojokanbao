import { describe, expect, it, vi } from "vitest";

import { dispatchTimesCapture, type SchedulerEnv } from "../src/dispatch";

const env: SchedulerEnv = {
  GITHUB_TOKEN: "test-token",
  GITHUB_OWNER: "kargonerd",
  GITHUB_REPO: "jojokanbao",
  GITHUB_WORKFLOW: "maintenance-times-capture.yml",
  GITHUB_PROCESS_WORKFLOW: "maintenance-times-process.yml",
  GITHUB_REF: "master",
};

const scheduledTime = Date.parse("2026-08-29T00:20:00.000Z");

interface TestRun {
  status: string;
  created_at?: string;
  display_title?: string;
}

function workflowRuns(runs: Array<string | TestRun> = []): Response {
  return Response.json({
    workflow_runs: runs.map((run) => (typeof run === "string" ? { status: run } : run)),
  });
}

describe("dispatchTimesCapture", () => {
  it("dispatches the production capture workflow with automatic inputs", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(workflowRuns())
      .mockResolvedValueOnce(workflowRuns(["completed"]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await dispatchTimesCapture(env, { fetcher, scheduledTime });

    expect(result).toEqual({
      owner: "kargonerd",
      repo: "jojokanbao",
      workflow: "maintenance-times-capture.yml",
      ref: "master",
      slotStartedAt: "2026-08-29T00:20:00.000Z",
      outcome: "dispatched",
      status: 204,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [url, init] = fetcher.mock.calls[2] ?? [];
    expect(url).toBe(
      "https://api.github.com/repos/kargonerd/jojokanbao/actions/workflows/maintenance-times-capture.yml/dispatches",
    );
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token");
    expect(JSON.parse(String(init?.body))).toEqual({
      ref: "master",
      inputs: {
        automatic: "true",
        publish: "true",
        since_hours: "1",
        sources: "",
      },
    });
  });

  it("skips dispatch while capture or process is active", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(workflowRuns(["in_progress"]))
      .mockResolvedValueOnce(workflowRuns(["queued"]));

    await expect(dispatchTimesCapture(env, { fetcher, scheduledTime })).resolves.toEqual({
      owner: "kargonerd",
      repo: "jojokanbao",
      workflow: "maintenance-times-capture.yml",
      ref: "master",
      slotStartedAt: "2026-08-29T00:20:00.000Z",
      outcome: "skipped",
      reason: "active-workflows",
      activeWorkflows: ["maintenance-times-capture.yml", "maintenance-times-process.yml"],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("skips a slot that already has an automatic capture run", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        workflowRuns([
          {
            status: "completed",
            display_title: "Times capture [cloudflare-cron]",
            created_at: "2026-08-29T00:20:53Z",
          },
        ]),
      )
      .mockResolvedValueOnce(workflowRuns(["completed"]));

    await expect(dispatchTimesCapture(env, { fetcher, scheduledTime })).resolves.toEqual({
      owner: "kargonerd",
      repo: "jojokanbao",
      workflow: "maintenance-times-capture.yml",
      ref: "master",
      slotStartedAt: "2026-08-29T00:20:00.000Z",
      outcome: "skipped",
      reason: "slot-already-dispatched",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("catches up after the previous slot finishes", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        workflowRuns([
          {
            status: "completed",
            display_title: "Times capture [cloudflare-cron]",
            created_at: "2026-08-29T00:10:53Z",
          },
        ]),
      )
      .mockResolvedValueOnce(workflowRuns(["completed"]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      dispatchTimesCapture(env, {
        fetcher,
        scheduledTime: Date.parse("2026-08-29T00:23:00Z"),
      }),
    ).resolves.toMatchObject({ outcome: "dispatched", slotStartedAt: "2026-08-29T00:20:00.000Z" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not let a completed manual run consume the automatic slot", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        workflowRuns([
          {
            status: "completed",
            display_title: "Times capture [manual]",
            created_at: "2026-08-29T00:21:00Z",
          },
        ]),
      )
      .mockResolvedValueOnce(workflowRuns())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(dispatchTimesCapture(env, { fetcher, scheduledTime })).resolves.toMatchObject({
      outcome: "dispatched",
    });
  });

  it("fails without making a request when a required value is empty", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(
      dispatchTimesCapture({ ...env, GITHUB_TOKEN: " " }, { fetcher, scheduledTime }),
    ).rejects.toThrow("GITHUB_TOKEN is not configured");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("surfaces a bounded GitHub API failure", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("permission denied", { status: 403 }));

    await expect(dispatchTimesCapture(env, { fetcher, scheduledTime })).rejects.toThrow(
      "GitHub workflow activity check failed for maintenance-times-capture.yml with HTTP 403: permission denied",
    );
  });
});
