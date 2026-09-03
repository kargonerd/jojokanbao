import { compactDateAt, resolveScheduledSlot } from "./schedule";
import type { ScheduledTask } from "./types";

export const SCHEDULED_TASKS = [
  {
    id: "times-capture",
    cron: "*/5 * * * *",
    timeZone: "UTC",
    catchupWindowMinutes: 5,
    workflow: "maintenance-times-capture.yml",
    automaticRunTitle: "Times capture [cloudflare-cron]",
    skipWhileWorkflowActive: true,
    maxAttempts: 1,
    retryDelayMinutes: 0,
    healthcheckBinding: "HEALTHCHECKS_TIMES_PIPELINE_URL",
    inputs: ({ slot }) => ({
      automatic: "true",
      publish: "true",
      scheduled_at: slot.scheduledAt,
      schedule_slot: slot.id,
      since_hours: "1",
      sources: "",
    }),
  },
  {
    id: "rmrb-sync",
    cron: "0 1 * * *",
    timeZone: "UTC",
    catchupWindowMinutes: 180,
    workflow: "maintenance-sync-rmrb.yml",
    automaticRunTitle: "RMRB sync [cloudflare-cron]",
    skipWhileWorkflowActive: true,
    maxAttempts: 3,
    retryDelayMinutes: 15,
    healthcheckBinding: "HEALTHCHECKS_RMRB_SYNC_URL",
    inputs: ({ slot }) => ({
      automatic: "true",
      date: compactDateAt(slot.scheduledAtMs, "Asia/Shanghai"),
      force: "false",
      scheduled_at: slot.scheduledAt,
      schedule_slot: slot.id,
    }),
  },
] satisfies ScheduledTask[];

export function scheduledTask(taskId: string): ScheduledTask {
  const task = SCHEDULED_TASKS.find((candidate) => candidate.id === taskId);
  if (!task) {
    throw new Error(`Unknown scheduled task: ${taskId}`);
  }
  return task;
}

export function validateScheduledTasks(tasks: readonly ScheduledTask[] = SCHEDULED_TASKS): void {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(task.id)) {
      throw new Error(`Scheduled task id must be kebab-case: ${task.id}`);
    }
    if (ids.has(task.id)) {
      throw new Error(`Duplicate scheduled task id: ${task.id}`);
    }
    ids.add(task.id);

    if (!/^[a-z0-9][a-z0-9-]*\.ya?ml$/u.test(task.workflow)) {
      throw new Error(`Scheduled task workflow must be a workflow filename: ${task.workflow}`);
    }
    if (!Number.isInteger(task.maxAttempts) || task.maxAttempts < 1) {
      throw new Error(`Scheduled task maxAttempts must be positive: ${task.id}`);
    }
    if (!Number.isInteger(task.retryDelayMinutes) || task.retryDelayMinutes < 0) {
      throw new Error(`Scheduled task retry delay must be non-negative: ${task.id}`);
    }

    // Parse every cron expression in CI even when the task is not due at the
    // chosen reference time.
    resolveScheduledSlot(task, Date.parse("2026-01-02T12:34:00.000Z"));
  }
}
