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
}

export interface DispatchedResult extends ResultBase {
  outcome: "dispatched";
  status: number;
}

export interface SkippedResult extends ResultBase {
  outcome: "skipped";
  activeWorkflows: string[];
}

export type DispatchResult = DispatchedResult | SkippedResult;

type Fetcher = typeof fetch;

interface WorkflowRunsResponse {
  workflow_runs?: Array<{ status?: string }>;
}

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

async function hasActiveRun(
  endpoint: string,
  workflow: string,
  headers: HeadersInit,
  fetcher: Fetcher,
): Promise<boolean> {
  const response = await fetcher(`${endpoint}/runs?per_page=10`, { headers });
  if (!response.ok) {
    const responseBody = (await response.text()).slice(0, 1_000);
    throw new Error(
      `GitHub workflow activity check failed for ${workflow} with HTTP ${response.status}: ${responseBody || response.statusText}`,
    );
  }

  const payload = (await response.json()) as WorkflowRunsResponse;
  return (payload.workflow_runs ?? []).some((run) => run.status !== "completed");
}

export async function dispatchTimesCapture(
  env: SchedulerEnv,
  fetcher: Fetcher = fetch,
): Promise<DispatchResult> {
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
  const active = await Promise.all(
    workflowEndpoints.map(async ({ endpoint, name }) => ({
      name,
      active: await hasActiveRun(endpoint, name, headers, fetcher),
    })),
  );
  const activeWorkflows = active.filter((item) => item.active).map((item) => item.name);
  if (activeWorkflows.length > 0) {
    return { owner, repo, workflow, ref, outcome: "skipped", activeWorkflows };
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

  return { owner, repo, workflow, ref, outcome: "dispatched", status: response.status };
}
