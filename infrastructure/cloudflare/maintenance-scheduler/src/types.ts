export interface SchedulerEnv {
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_REF: string;
  HEALTHCHECKS_API_KEY?: string;
  MONITORS?: DurableObjectNamespace;
}

export interface AlertPolicy {
  /** Consecutive distinct execution attempts, not repeated HTTP deliveries. */
  executionFailures: number;
  dispatchFailureSeconds: number;
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
    alertPolicy?: Partial<AlertPolicy>;
    // Independently reported downstream stages inherit this task's schedule.
    stages?: Array<Omit<HealthcheckDefinition, "schedule" | "timeZone"> & { alertPolicy?: Partial<AlertPolicy> }>;
  };
  inputs(context: TaskInputContext): Record<string, string>;
}

export function taskHealthcheck(task: ScheduledTask): HealthcheckDefinition {
  const { stages: _stages, alertPolicy: _policy, ...monitoring } = task.monitoring;
  return {
    ...monitoring,
    slug: task.id,
    schedule: task.cron,
    timeZone: task.timeZone,
  };
}

export function taskStageHealthchecks(task: ScheduledTask): HealthcheckDefinition[] {
  return (task.monitoring.stages ?? []).map(({ alertPolicy: _policy, ...stage }) => ({
    ...stage,
    schedule: task.cron,
    timeZone: task.timeZone,
  }));
}
