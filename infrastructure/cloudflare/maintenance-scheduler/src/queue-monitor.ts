import { pingHealthcheck } from "./healthchecks";
import type { QueuePolicy, SchedulerEnv } from "./types";

const waitingStatuses = ["pending", "queued", "waiting", "requested"];

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
  await Promise.all(policy.workflows.flatMap((workflow) => waitingStatuses.map(async (status) => {
    const endpoint = `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/actions/workflows/${encodeURIComponent(workflow)}`;
    const response = await fetcher(`${endpoint}/runs?status=${status}&per_page=100`, {
      headers: {
        Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "User-Agent": "jojokanbao-maintenance-scheduler", "X-GitHub-Api-Version": "2026-03-10",
      }, signal: AbortSignal.timeout(10_000), redirect: "manual",
    });
    if (!response.ok) throw new Error(`Queue probe ${workflow}/${status}: HTTP ${response.status}`);
    const payload = await response.json() as { total_count: number; workflow_runs: Array<{ id: number; status: string; created_at: string }> };
    if (!Number.isInteger(payload.total_count) || payload.total_count < 0 || !Array.isArray(payload.workflow_runs) ||
        payload.total_count < payload.workflow_runs.length || (payload.total_count > 0 && !payload.workflow_runs.length)) {
      throw new Error(`Invalid queue response for ${workflow}/${status}`);
    }
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
  storage: DurableObjectStorage, env: SchedulerEnv, policy: QueuePolicy,
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
