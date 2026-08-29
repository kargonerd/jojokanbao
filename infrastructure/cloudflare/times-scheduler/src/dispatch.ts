export interface SchedulerEnv {
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_WORKFLOW: string;
  GITHUB_PROCESS_WORKFLOW: string;
  GITHUB_REF: string;
}

interface ResultBase {
  owner: string;
  repo: string;
  workflow: string;
  ref: string;
  slotStartedAt: string;
}

export interface DispatchedResult extends ResultBase {
  outcome: "dispatched";
  status: number;
}

export interface ActiveWorkflowsSkippedResult extends ResultBase {
  outcome: "skipped";
  reason: "active-workflows";
  activeWorkflows: string[];
}

export interface SlotAlreadyDispatchedResult extends ResultBase {
  outcome: "skipped";
  reason: "slot-already-dispatched";
}

export type DispatchResult =
  | DispatchedResult
  | ActiveWorkflowsSkippedResult
  | SlotAlreadyDispatchedResult;

type Fetcher = typeof fetch;

interface WorkflowRun {
  status?: string;
  created_at?: string;
  display_title?: string;
}

interface WorkflowRunsResponse {
  workflow_runs?: WorkflowRun[];
}

export interface DispatchOptions {
  fetcher?: Fetcher;
  scheduledTime?: number;
}

const SLOT_DURATION_MS = 10 * 60 * 1_000;
const AUTOMATIC_CAPTURE_TITLE = "Times capture [cloudflare-cron]";

function requireValue(name: keyof SchedulerEnv, value: string | undefined): string {
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
  const response = await fetcher(`${endpoint}/runs?per_page=10`, { headers });
  if (!response.ok) {
    const responseBody = (await response.text()).slice(0, 1_000);
    throw new Error(
      `GitHub workflow activity check failed for ${workflow} with HTTP ${response.status}: ${responseBody || response.statusText}`,
    );
  }

  const payload = (await response.json()) as WorkflowRunsResponse;
  return payload.workflow_runs ?? [];
}

function isRunInSlot(run: WorkflowRun, slotStartedAt: number): boolean {
  if (run.display_title !== AUTOMATIC_CAPTURE_TITLE || !run.created_at) {
    return false;
  }

  const createdAt = Date.parse(run.created_at);
  return (
    Number.isFinite(createdAt) &&
    createdAt >= slotStartedAt &&
    createdAt < slotStartedAt + SLOT_DURATION_MS
  );
}

export async function dispatchTimesCapture(
  env: SchedulerEnv,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const fetcher = options.fetcher ?? fetch;
  const scheduledTime = options.scheduledTime ?? Date.now();
  const slotStartedAtMs = Math.floor(scheduledTime / SLOT_DURATION_MS) * SLOT_DURATION_MS;
  const slotStartedAt = new Date(slotStartedAtMs).toISOString();
  const token = requireValue("GITHUB_TOKEN", env.GITHUB_TOKEN);
  const owner = requireValue("GITHUB_OWNER", env.GITHUB_OWNER);
  const repo = requireValue("GITHUB_REPO", env.GITHUB_REPO);
  const workflow = requireValue("GITHUB_WORKFLOW", env.GITHUB_WORKFLOW);
  const processWorkflow = requireValue("GITHUB_PROCESS_WORKFLOW", env.GITHUB_PROCESS_WORKFLOW);
  const ref = requireValue("GITHUB_REF", env.GITHUB_REF);
  const workflowEndpoints = [workflow, processWorkflow].map((name) => ({
    name,
    endpoint: workflowEndpoint(owner, repo, name),
  }));
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "jojokanbao-times-scheduler",
    "X-GitHub-Api-Version": "2026-03-10",
  };
  const workflowRuns = await Promise.all(
    workflowEndpoints.map(async ({ endpoint, name }) => ({
      name,
      runs: await getWorkflowRuns(endpoint, name, headers, fetcher),
    })),
  );
  const activeWorkflows = workflowRuns
    .filter((item) => item.runs.some((run) => run.status !== "completed"))
    .map((item) => item.name);
  if (activeWorkflows.length > 0) {
    return {
      owner,
      repo,
      workflow,
      ref,
      slotStartedAt,
      outcome: "skipped",
      reason: "active-workflows",
      activeWorkflows,
    };
  }

  const captureRuns = workflowRuns.find((item) => item.name === workflow)?.runs ?? [];
  if (captureRuns.some((run) => isRunInSlot(run, slotStartedAtMs))) {
    return {
      owner,
      repo,
      workflow,
      ref,
      slotStartedAt,
      outcome: "skipped",
      reason: "slot-already-dispatched",
    };
  }

  const response = await fetcher(`${workflowEndpoints[0]?.endpoint}/dispatches`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ref,
      inputs: {
        automatic: "true",
        publish: "true",
        since_hours: "1",
        sources: "",
      },
    }),
  });

  if (!response.ok) {
    const responseBody = (await response.text()).slice(0, 1_000);
    throw new Error(
      `GitHub workflow dispatch failed with HTTP ${response.status}: ${responseBody || response.statusText}`,
    );
  }

  return {
    owner,
    repo,
    workflow,
    ref,
    slotStartedAt,
    outcome: "dispatched",
    status: response.status,
  };
}
