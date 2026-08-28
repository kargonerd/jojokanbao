export interface SchedulerEnv {
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_WORKFLOW: string;
  GITHUB_REF: string;
}

export interface DispatchResult {
  owner: string;
  repo: string;
  workflow: string;
  ref: string;
  status: number;
}

type Fetcher = typeof fetch;

function requireValue(name: keyof SchedulerEnv, value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is not configured`);
  }
  return normalized;
}

export async function dispatchTimesCapture(
  env: SchedulerEnv,
  fetcher: Fetcher = fetch,
): Promise<DispatchResult> {
  const token = requireValue("GITHUB_TOKEN", env.GITHUB_TOKEN);
  const owner = requireValue("GITHUB_OWNER", env.GITHUB_OWNER);
  const repo = requireValue("GITHUB_REPO", env.GITHUB_REPO);
  const workflow = requireValue("GITHUB_WORKFLOW", env.GITHUB_WORKFLOW);
  const ref = requireValue("GITHUB_REF", env.GITHUB_REF);
  const endpoint = [
    "https://api.github.com/repos",
    encodeURIComponent(owner),
    encodeURIComponent(repo),
    "actions/workflows",
    encodeURIComponent(workflow),
    "dispatches",
  ].join("/");

  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "jojokanbao-times-scheduler",
      "X-GitHub-Api-Version": "2026-03-10",
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

  return { owner, repo, workflow, ref, status: response.status };
}
