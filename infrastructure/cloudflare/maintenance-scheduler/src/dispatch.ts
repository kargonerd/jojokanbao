import type { ScheduledSlot, ScheduledTask, SchedulerEnv } from "./types";

interface ResultBase {
  taskId: string;
  owner: string;
  repo: string;
  workflow: string;
  ref: string;
  slotId: string;
  slotStartedAt: string;
  slotEndsAt: string;
}

export interface DispatchedResult extends ResultBase {
  outcome: "dispatched";
  httpStatus: number;
  attempt: number;
}

export interface SkippedResult extends ResultBase {
  outcome: "skipped";
  reason:
    | "active-workflows"
    | "attempts-exhausted"
    | "retry-delay"
    | "slot-already-dispatched";
  activeWorkflows?: string[];
  attempts?: number;
}

export type DispatchResult = DispatchedResult | SkippedResult;

type Fetcher = typeof fetch;

interface WorkflowRun {
  status?: string;
  conclusion?: string | null;
  created_at?: string;
  display_title?: string;
}

interface WorkflowRunsResponse {
  workflow_runs?: WorkflowRun[];
}

export interface DispatchOptions {
  fetcher?: Fetcher | undefined;
  observedAtMs: number;
  slot: ScheduledSlot;
}

function requireValue(name: string, value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is not configured`);
  }
  return normalized;
}

function workflowEndpoint(owner: string, repo: string, workflow: string): string {
  return [
    "https://api.github.com/repos",
    encodeURIComponent(owner),
    encodeURIComponent(repo),
    "actions/workflows",
    encodeURIComponent(workflow),
  ].join("/");
}

async function getWorkflowRuns(
  endpoint: string,
  workflow: string,
  headers: HeadersInit,
  fetcher: Fetcher,
): Promise<WorkflowRun[]> {
  const response = await fetcher(`${endpoint}/runs?per_page=50`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const responseBody = (await response.text()).slice(0, 1_000);
    throw new Error(
      `GitHub workflow activity check failed for ${workflow} with HTTP ${response.status}: ${responseBody || response.statusText}`,
    );
  }

  const payload = (await response.json()) as WorkflowRunsResponse;
  if (!Array.isArray(payload.workflow_runs)) {
    throw new Error(`GitHub workflow activity check returned invalid runs for ${workflow}`);
  }
  return payload.workflow_runs;
}

function automaticRunsInSlot(
  runs: WorkflowRun[],
  task: ScheduledTask,
  slot: ScheduledSlot,
): Array<WorkflowRun & { createdAtMs: number }> {
  return runs.flatMap((run) => {
    if (run.display_title !== task.automaticRunTitle || !run.created_at) {
      return [];
    }
    const createdAtMs = Date.parse(run.created_at);
    if (
      !Number.isFinite(createdAtMs) ||
      createdAtMs < slot.scheduledAtMs ||
      createdAtMs >= slot.endsAtMs
    ) {
      return [];
    }
    return [{ ...run, createdAtMs }];
  }).sort((left, right) => right.createdAtMs - left.createdAtMs);
}

function baseResult(
  task: ScheduledTask,
  slot: ScheduledSlot,
  owner: string,
  repo: string,
  ref: string,
): ResultBase {
  return {
    taskId: task.id,
    owner,
    repo,
    workflow: task.workflow,
    ref,
    slotId: slot.id,
    slotStartedAt: slot.scheduledAt,
    slotEndsAt: slot.endsAt,
  };
}

export async function dispatchScheduledTask(
  task: ScheduledTask,
  env: SchedulerEnv,
  options: DispatchOptions,
): Promise<DispatchResult> {
  const fetcher = options.fetcher ?? fetch;
  const token = requireValue("GITHUB_TOKEN", env.GITHUB_TOKEN);
  const owner = requireValue("GITHUB_OWNER", env.GITHUB_OWNER);
  const repo = requireValue("GITHUB_REPO", env.GITHUB_REPO);
  const ref = requireValue("GITHUB_REF", env.GITHUB_REF);
  const endpoint = workflowEndpoint(owner, repo, task.workflow);
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "jojokanbao-maintenance-scheduler",
    "X-GitHub-Api-Version": "2026-03-10",
  };
  const base = baseResult(task, options.slot, owner, repo, ref);
  const runs = await getWorkflowRuns(endpoint, task.workflow, headers, fetcher);

  if (task.skipWhileWorkflowActive && runs.some((run) => run.status !== "completed")) {
    return {
      ...base,
      outcome: "skipped",
      reason: "active-workflows",
      activeWorkflows: [task.workflow],
    };
  }

  const automaticRuns = automaticRunsInSlot(runs, task, options.slot);
  if (
    automaticRuns.some((run) => run.conclusion === "success") ||
    (task.maxAttempts === 1 && automaticRuns.length > 0)
  ) {
    return {
      ...base,
      outcome: "skipped",
      reason: "slot-already-dispatched",
      attempts: automaticRuns.length,
    };
  }

  if (automaticRuns.length >= task.maxAttempts) {
    return {
      ...base,
      outcome: "skipped",
      reason: "attempts-exhausted",
      attempts: automaticRuns.length,
    };
  }

  const latestRun = automaticRuns[0];
  if (latestRun && options.observedAtMs - latestRun.createdAtMs < task.retryDelayMinutes * 60_000) {
    return {
      ...base,
      outcome: "skipped",
      reason: "retry-delay",
      attempts: automaticRuns.length,
    };
  }

  const observedAt = new Date(options.observedAtMs).toISOString();
  const response = await fetcher(`${endpoint}/dispatches`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ref,
      inputs: task.inputs({ observedAt, slot: options.slot, taskId: task.id }),
    }),
    // A timed-out POST may have been accepted. Reconcile runs on the next
    // minute tick instead of blindly retrying and creating duplicate jobs.
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const responseBody = (await response.text()).slice(0, 1_000);
    throw new Error(
      `GitHub workflow dispatch failed for ${task.id} with HTTP ${response.status}: ${responseBody || response.statusText}`,
    );
  }

  return {
    ...base,
    outcome: "dispatched",
    httpStatus: response.status,
    attempt: automaticRuns.length + 1,
  };
}
