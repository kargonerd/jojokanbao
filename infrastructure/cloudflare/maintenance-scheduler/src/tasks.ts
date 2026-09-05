import { compactDateAt, resolveScheduledSlot } from "./schedule";
import { taskHealthcheck, taskStageHealthchecks, type ScheduledTask } from "./types";

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
    monitoring: {
      name: "JOJO · times-capture",
      // Capture has a 35-minute budget, plus runner queue/catch-up time.
      graceSeconds: 45 * 60,
      tags: "jojo production maintenance times",
      description: "Cloudflare dispatch through durable Times Raw publication. Process reports separately.",
      stages: [{
        slug: "times-process",
        name: "JOJO · times-process",
        graceSeconds: 90 * 60,
        tags: "jojo production maintenance times process",
        description: "Committed Times Runtime batches after Canonical/B2 publication; includes drain continuations. No-op runs do not clear alerts.",
      }],
    },
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
    monitoring: {
      name: "JOJO · rmrb-sync",
      graceSeconds: 45 * 60,
      tags: "jojo production maintenance rmrb",
      description: "Daily RMRB PDF dispatch and synchronization outcome.",
    },
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
  const checkIds = new Set<string>(["maintenance-scheduler"]);
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
    if (!Number.isInteger(task.monitoring.graceSeconds) || task.monitoring.graceSeconds < 60) {
      throw new Error(`Scheduled task monitoring grace must be at least one minute: ${task.id}`);
    }
    for (const check of [taskHealthcheck(task), ...taskStageHealthchecks(task)]) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(check.slug) || checkIds.has(check.slug)) {
        throw new Error(`Invalid or duplicate Healthchecks slug: ${check.slug}`);
      }
      if (!Number.isInteger(check.graceSeconds) || check.graceSeconds < 60) {
        throw new Error(`Healthchecks grace must be at least one minute: ${check.slug}`);
      }
      checkIds.add(check.slug);
    }

    // Parse every cron expression in CI even when the task is not due at the
    // chosen reference time.
    resolveScheduledSlot(task, Date.parse("2026-01-02T12:34:00.000Z"));
  }
}
