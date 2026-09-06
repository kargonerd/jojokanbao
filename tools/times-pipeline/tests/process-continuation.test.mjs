import { describe, expect, it, vi } from "vitest";
import { continueTimesProcess } from "../../ci/continue-times-process.mjs";

const env = { GH_TOKEN: "test", GITHUB_REPOSITORY: "kargonerd/jojokanbao", GITHUB_RUN_ID: "1", TIMES_GITHUB_REF: "master", TIMES_MAX_JOBS: "4" };
const run = { id: 2, status: "pending", head_branch: "master", display_title: "Times process [automatic]" };
function fixture(runs = []) {
  return vi.fn(async (input, init) => init?.method === "POST" ? new Response(null, { status: 204 }) :
    Response.json({ workflow_runs: runs.filter((run) => run.status === new URL(input).searchParams.get("status")) }));
}

describe("Process continuation admission", () => {
  it.each(["pending", "queued", "waiting", "requested"])("reuses a %s automatic request without dispatching", async (status) => {
    const fetcher = fixture([{ ...run, status }]);
    expect(await continueTimesProcess(env, fetcher)).toEqual({ outcome: "coalesced", pendingRunId: 2 });
    expect(fetcher.mock.calls.some(([, init]) => init.method === "POST")).toBe(false);
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toContain("per_page=100");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it.each([
    { ...run, id: 1 }, { ...run, display_title: "Times process [request 2]" },
    { ...run, head_branch: "feature" }, { ...run, status: "completed" },
  ])("does not mistake self/manual/another branch/completion for a continuation: %j", async (candidate) => {
    const fetcher = fixture([candidate]);
    expect(await continueTimesProcess(env, fetcher)).toEqual({ outcome: "dispatched" });
    expect(fetcher).toHaveBeenCalledTimes(5);
    const [url, init] = fetcher.mock.calls.at(-1);
    expect(url).toMatch(/\/dispatches$/u);
    expect(JSON.parse(init.body)).toEqual({ ref: "master", inputs: { publish: "true", drain: "true", max_jobs: "4" } });
  });

  it("does not turn an unavailable or malformed probe into an empty queue", async () => {
    for (const response of [new Response(null, { status: 502 }), Response.json({})]) {
      const fetcher = vi.fn().mockResolvedValue(response);
      await expect(continueTimesProcess(env, fetcher)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("never retries a dispatch with ambiguous acceptance", async () => {
    const fetcher = fixture();
    fetcher.mockImplementationOnce(() => Response.json({ workflow_runs: [] }));
    const wrapped = vi.fn((input, init) => {
      if (init.method === "POST") throw new Error("timeout");
      return fetcher(input, init);
    });
    await expect(continueTimesProcess(env, wrapped)).rejects.toThrow("timeout");
    expect(wrapped.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  });
});
