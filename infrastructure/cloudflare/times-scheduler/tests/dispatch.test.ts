import { describe, expect, it, vi } from "vitest";

import { dispatchTimesCapture, type SchedulerEnv } from "../src/dispatch";

const env: SchedulerEnv = {
  GITHUB_TOKEN: "test-token",
  GITHUB_OWNER: "kargonerd",
  GITHUB_REPO: "jojokanbao",
  GITHUB_WORKFLOW: "maintenance-times-capture.yml",
  GITHUB_REF: "master",
};

describe("dispatchTimesCapture", () => {
  it("dispatches the production capture workflow with automatic inputs", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

    const result = await dispatchTimesCapture(env, fetcher);

    expect(result).toEqual({
      owner: "kargonerd",
      repo: "jojokanbao",
      workflow: "maintenance-times-capture.yml",
      ref: "master",
      status: 204,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
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
      .mockResolvedValue(new Response("permission denied", { status: 403 }));

    await expect(dispatchTimesCapture(env, fetcher)).rejects.toThrow(
      "GitHub workflow dispatch failed with HTTP 403: permission denied",
    );
  });
});
