export interface SchedulerEnv {
  [binding: string]: string | undefined;
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_REF: string;
  HEALTHCHECKS_SCHEDULER_URL?: string;
  HEALTHCHECKS_TIMES_SCHEDULER_URL?: string;
  HEALTHCHECKS_TIMES_PIPELINE_URL?: string;
  HEALTHCHECKS_RMRB_SYNC_URL?: string;
}

export type TaskHealthcheckBinding = `HEALTHCHECKS_${string}_URL`;

export interface ScheduledSlot {
  id: string;
  scheduledAtMs: number;
  scheduledAt: string;
  endsAtMs: number;
  endsAt: string;
}

export interface TaskInputContext {
  observedAt: string;
  slot: ScheduledSlot;
  taskId: string;
}

export interface ScheduledTask {
  id: string;
  cron: string;
  timeZone: string;
  catchupWindowMinutes: number;
  workflow: string;
  automaticRunTitle: string;
  skipWhileWorkflowActive: boolean;
  maxAttempts: number;
  retryDelayMinutes: number;
  healthcheckBinding: TaskHealthcheckBinding;
  inputs(context: TaskInputContext): Record<string, string>;
}

export function taskHealthcheckUrl(task: ScheduledTask, env: SchedulerEnv): string | undefined {
  return env[task.healthcheckBinding];
}
