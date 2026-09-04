export interface SchedulerEnv {
  [binding: string]: string | undefined;
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_REF: string;
  HEALTHCHECKS_API_KEY?: string;
}

export interface HealthcheckDefinition {
  name: string;
  slug: string;
  schedule: string;
  timeZone: string;
  graceSeconds: number;
  tags: string;
  description: string;
}

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
  monitoring: {
    name: string;
    graceSeconds: number;
    tags: string;
    description: string;
  };
  inputs(context: TaskInputContext): Record<string, string>;
}

export function taskHealthcheck(task: ScheduledTask): HealthcheckDefinition {
  return {
    ...task.monitoring,
    slug: task.id,
    schedule: task.cron,
    timeZone: task.timeZone,
  };
}
