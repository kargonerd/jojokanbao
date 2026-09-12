import { DispatchError, dispatchScheduledTask, type DispatchResult } from "./dispatch";
import { reportHealthcheckBestEffort } from "./healthchecks";
import { type MonitorTick } from "./monitor-object";
import type { DispatchObservation } from "./monitor-policy";
import { resolveScheduledSlot } from "./schedule";
import { SCHEDULED_TASKS } from "./tasks";
import { taskStageHealthchecks, type HealthcheckDefinition, type ScheduledTask, type SchedulerEnv } from "./types";



export interface ScheduledOptions {
  fetcher?: typeof fetch | undefined;
  tasks?: readonly ScheduledTask[];
  monitor: (tick: MonitorTick) => Promise<void>;
  dispatch?: typeof dispatchScheduledTask;
  schedulerDescription?: string;
}

export const SCHEDULER_HEALTHCHECK: HealthcheckDefinition = {
  name: "JOJO · maintenance-scheduler", slug: "maintenance-scheduler", schedule: "* * * * *", timeZone: "UTC",
  // Allow short dependency failures plus the 90-second lease after a lost tick.
  graceSeconds: 5 * 60, tags: "jojo production maintenance scheduler",
  description: "One-minute scheduler and alert-policy consumer heartbeat.",
};

function observation(result: PromiseSettledResult<DispatchResult | undefined>): DispatchObservation {
  if (result.status === "rejected") return {
    kind: "failed", permanent: result.reason instanceof DispatchError && result.reason.permanent,
    reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
  };
  if (!result.value) return { kind: "idle" };
  if (result.value.outcome === "skipped" && result.value.reason === "attempts-exhausted") return { kind: "exhausted" };
  return { kind: "accepted" };
}

export async function handleScheduled(controller: { scheduledTime: number; cron: string }, env: SchedulerEnv, options: ScheduledOptions): Promise<void> {
  const tasks = options.tasks ?? SCHEDULED_TASKS;
  const observedAt = new Date(controller.scheduledTime).toISOString();
  const slots = new Map<string, number>();
  const settled = await Promise.allSettled(tasks.map(async (task) => {
    const slot = resolveScheduledSlot(task, controller.scheduledTime);
    if (slot) slots.set(task.id, slot.scheduledAtMs);
    return slot ? (options.dispatch ?? dispatchScheduledTask)(task, env, { fetcher: options.fetcher, observedAtMs: controller.scheduledTime, slot }) : undefined;
  }));
  const monitor = options.monitor;
  const monitorCount = tasks.reduce((count, task) => count + 1 + taskStageHealthchecks(task).length, 0);
  const bodyBudget = Math.max(1, Math.min(8, Math.floor(48 / Math.max(1, monitorCount))));
  const monitorTicks = tasks.flatMap((task, index) => {
    const dispatch = observation(settled[index]!);
    const expectedAt = slots.get(task.id);
    const timing = expectedAt === undefined ? {} : { expectedAt };
    if (dispatch.kind === "failed") console.error(JSON.stringify({ event: "scheduled_task_failed", taskId: task.id, observedAt, ...dispatch }));
    // /start on retries would reset Healthchecks' grace timer.
    return [
      { slug: task.id, now: controller.scheduledTime, dispatch, bodyBudget, ...timing },
      ...taskStageHealthchecks(task).map((check) => ({ slug: check.slug, now: controller.scheduledTime, bodyBudget, ...timing })),
    ];
  });
  const checks = await Promise.allSettled(monitorTicks.map(async (tick) => monitor(tick)));
  const monitorFailures = checks.filter((result) => result.status === "rejected");
  checks.forEach((result, index) => {
    if (result.status === "rejected") console.error(JSON.stringify({ event: "maintenance_monitor_failed", taskId: monitorTicks[index]!.slug, error: String(result.reason) }));
  });
  await reportHealthcheckBestEffort({ ...SCHEDULER_HEALTHCHECK, description: options.schedulerDescription ?? SCHEDULER_HEALTHCHECK.description }, env.HEALTHCHECKS_API_KEY, monitorFailures.length ? "log" : "success", {
    fetcher: options.fetcher,
    payload: { stage: "maintenance-scheduler", status: monitorFailures.length ? "degraded" : "completed", observedAt, monitorFailures: monitorFailures.length },
  });
  console.log(JSON.stringify({ event: "maintenance_scheduler_tick", observedAt, cron: controller.cron,
    failedTasks: settled.filter((result) => result.status === "rejected").length,
    monitorFailures: monitorFailures.length,
    results: settled.map((result, index) => result.status === "fulfilled" ? result.value ?? { taskId: tasks[index]?.id, due: false } : { taskId: tasks[index]?.id, error: String(result.reason) }),
  }));
}
