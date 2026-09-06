import { pingHealthcheck } from "./healthchecks";
import type { QueuePolicy, SchedulerEnv, StateStore } from "./types";

const waitingStatuses = ["pending", "queued", "waiting", "requested"];
const snapshotRetryDelays = [500, 1500];

function waitForSnapshot(delay: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, delay);
    signal.addEventListener("abort", abort, { once: true });
  });
}

interface QueueSnapshot {
  total_count: number;
  workflow_runs: Array<{ id: number; status: string; created_at: string }>;
}

async function readQueueSnapshot(
  workflow: string, status: string, env: SchedulerEnv, signal: AbortSignal, fetcher: typeof fetch,
): Promise<QueueSnapshot> {
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER!)}/${encodeURIComponent(env.GITHUB_REPO!)}/actions/workflows/${encodeURIComponent(workflow)}`;
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const response = await fetcher(`${endpoint}/runs?status=${status}&per_page=100`, {
      headers: {
        Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "User-Agent": "jojokanbao-maintenance-scheduler", "X-GitHub-Api-Version": "2026-03-10",
      }, signal, redirect: "manual",
    });
    if (!response.ok) throw new Error(`Queue probe ${workflow}/${status}: HTTP ${response.status}`);
    const payload = await response.json() as QueueSnapshot | null;
    if (!payload || !Number.isInteger(payload.total_count) || payload.total_count < 0 || !Array.isArray(payload.workflow_runs)) {
      throw new Error(`Invalid queue response for ${workflow}/${status}`);
    }
    if (payload.total_count >= payload.workflow_runs.length && (payload.total_count === 0 || payload.workflow_runs.length > 0)) return payload;

    // GitHub can briefly return e.g. { total_count: 1, workflow_runs: [] }
    // during a queued -> pending transition. Retry only this inconsistent
    // snapshot; never convert it to an empty/healthy queue or retry bad auth.
    const requestId = response.headers.get("x-github-request-id") ?? "";
    const diagnostic = { workflow, status, attempt: attempt + 1, totalCount: payload.total_count,
      runCount: payload.workflow_runs.length, requestId: /^[a-zA-Z0-9:-]{1,128}$/.test(requestId) ? requestId : "unavailable" };
    const delay = snapshotRetryDelays[attempt];
    if (delay === undefined) throw new Error(`Invalid queue response for ${workflow}/${status}: ${JSON.stringify(diagnostic)}`);
    console.warn(JSON.stringify({ event: "maintenance_queue_snapshot_retry", ...diagnostic }));
    await waitForSnapshot(delay, signal);
  }
}

export interface QueueObservation {
  pendingRuns: number;
  oldestWaitSeconds: number;
  congested: boolean;
}

/** Status-filtered reads cannot hide old waiting runs behind recent completions. */
export async function observeQueue(policy: QueuePolicy, env: SchedulerEnv, now: number, fetcher = fetch): Promise<QueueObservation> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) throw new Error("GitHub queue credentials/configuration missing");
  const runs = new Map<number, number>();
  let countFloor = 0;
  // All parallel reads AND retries share the original 10-second probe budget.
  // Do not multiply request timeouts inside the 55-second SCF invocation.
  const signal = AbortSignal.timeout(10_000);
  await Promise.all(policy.workflows.flatMap((workflow) => waitingStatuses.map(async (status) => {
    const payload = await readQueueSnapshot(workflow, status, env, signal, fetcher);
    // Above the bounded page size it is already congested. Do not exhaust the
    // Worker request budget paginating a saturated queue just to find its age.
    countFloor = Math.max(countFloor, payload.total_count);
    for (const run of payload.workflow_runs) {
      const createdAt = Date.parse(run.created_at);
      if (!Number.isSafeInteger(run.id) || !Number.isFinite(createdAt) || typeof run.status !== "string") throw new Error("Invalid queued run");
      if (!waitingStatuses.includes(run.status)) continue; // Concurrent completion.
      runs.set(run.id, createdAt); // Deduplicate status changes between reads.
    }
  })));
  const pendingRuns = Math.max(countFloor, runs.size);
  const oldestWaitSeconds = runs.size ? Math.max(0, (now - Math.min(...runs.values())) / 1000) : 0;
  return { pendingRuns, oldestWaitSeconds,
    congested: pendingRuns > policy.maxPendingRuns || oldestWaitSeconds > policy.maxWaitSeconds };
}

export interface QueueState {
  checkUuid: string;
  observedAt: number;
  unhealthySince?: number;
  down: boolean;
  pending?: "start" | "success" | "fail";
}

/** A separate durable heartbeat: publishing success cannot clear this incident. */
export async function tickQueueMonitor(
  storage: StateStore, env: SchedulerEnv, policy: QueuePolicy,
  slug: string, pingUrl: string, uuid: string, now: number,
): Promise<{ cursor: number; down: boolean }> {
  const previous = await storage.get<QueueState>("queue-monitor");
  const state: QueueState = previous?.checkUuid === uuid ? structuredClone(previous) : {
    checkUuid: uuid, observedAt: -1, down: false, pending: "start",
  };
  // Ignore stale/replayed ticks; do not move a debounce clock backwards.
  if (now <= state.observedAt) return { cursor: 0, down: state.down };
  const observation = await observeQueue(policy, env, now);
  if (!observation.congested) {
    delete state.unhealthySince;
    state.down = false;
    state.pending = "success";
  } else {
    state.unhealthySince ??= now;
    // An undelivered healthy heartbeat must not be replayed after congestion.
    if (state.pending === "success") delete state.pending;
    if (!state.down && now - state.unhealthySince >= policy.failureSeconds * 1000) {
      state.down = true;
      state.pending = "fail";
    }
  }
  state.observedAt = now;
  await storage.put("queue-monitor", state);
  if (state.pending) {
    await pingHealthcheck(pingUrl, state.pending, { payload: {
      taskId: slug, stage: slug, status: state.pending,
      failureType: state.pending === "fail" ? "queue-congestion" : "",
      observedAt: new Date(now).toISOString(), ...observation,
      run: `https://github.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions`,
    } });
    delete state.pending;
    await storage.put("queue-monitor", state);
  }
  console.log(JSON.stringify({ event: "maintenance_queue_tick", taskId: slug, down: state.down, ...observation }));
  return { cursor: 0, down: state.down };
}
