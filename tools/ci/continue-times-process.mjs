import { pathToFileURL } from "node:url";

const workflow = "maintenance-times-process.yml";
const waitingStatuses = ["pending", "queued", "waiting", "requested"];

/** Best-effort deduplication; the workflow admission group closes API races. */
export async function continueTimesProcess(env = process.env, fetcher = fetch) {
  for (const key of ["GH_TOKEN", "GITHUB_REPOSITORY", "GITHUB_RUN_ID", "TIMES_GITHUB_REF", "TIMES_MAX_JOBS"]) {
    if (!env[key]) throw new Error(`${key} is required`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/u.test(env.GITHUB_REPOSITORY)) throw new Error("Invalid repository");
  if (!/^(?:[1-9]|1[0-9]|20)$/u.test(env.TIMES_MAX_JOBS)) throw new Error("Invalid max_jobs");
  const endpoint = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${workflow}`;
  const headers = {
    Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GH_TOKEN}`,
    "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "jojo-times-process",
  };
  for (const status of waitingStatuses) {
    const response = await fetcher(`${endpoint}/runs?status=${status}&per_page=100`, {
      headers, signal: AbortSignal.timeout(10_000), redirect: "error",
    });
    if (!response.ok) throw new Error(`Process queue probe failed: HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.workflow_runs)) throw new Error("Invalid Process queue response");
    const pending = payload.workflow_runs.find((run) =>
      String(run.id) !== env.GITHUB_RUN_ID && waitingStatuses.includes(run.status) &&
      run.head_branch === env.TIMES_GITHUB_REF && run.display_title === "Times process [automatic]",
    );
    if (pending) return { outcome: "coalesced", pendingRunId: pending.id };
  }
  // Never blindly retry a timed-out POST: acceptance is ambiguous. The next
  // Capture wakes Process again, and durable Runtime jobs are not acknowledged here.
  const response = await fetcher(`${endpoint}/dispatches`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000), redirect: "error",
    body: JSON.stringify({ ref: env.TIMES_GITHUB_REF, inputs: {
      publish: "true", drain: "true", max_jobs: env.TIMES_MAX_JOBS,
    } }),
  });
  if (!response.ok) throw new Error(`Process continuation failed: HTTP ${response.status}`);
  return { outcome: "dispatched" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  continueTimesProcess().then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
