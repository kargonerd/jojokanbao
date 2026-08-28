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

function workflowRuns(statuses: string[] = []): Response {
  return Response.json({ workflow_runs: statuses.map((status) => ({ status })) });
}

describe("dispatchTimesCapture", () => {
  it("dispatches the production capture workflow with automatic inputs", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(workflowRuns())
      .mockResolvedValueOnce(workflowRuns(["completed"]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await dispatchTimesCapture(env, fetcher);

    expect(result).toEqual({
      owner: "kargonerd",
      repo: "jojokanbao",
      workflow: "maintenance-times-capture.yml",
      ref: "master",
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

    await expect(dispatchTimesCapture(env, fetcher)).resolves.toEqual({
      owner: "kargonerd",
      repo: "jojokanbao",
      workflow: "maintenance-times-capture.yml",
      ref: "master",
      outcome: "skipped",
      activeWorkflows: ["maintenance-times-capture.yml", "maintenance-times-process.yml"],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails without making a request when a required value is empty", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(
      dispatchTimesCapture({ ...env, GITHUB_TOKEN: " " }, fetcher),
    ).rejects.toThrow("GITHUB_TOKEN is not configured");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("surfaces a bounded GitHub API failure", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("permission denied", { status: 403 }));

    await expect(dispatchTimesCapture(env, fetcher)).rejects.toThrow(
      "GitHub workflow activity check failed for maintenance-times-capture.yml with HTTP 403: permission denied",
    );
  });
});
