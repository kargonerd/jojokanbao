import { DispatchError, dispatchScheduledTask, type DispatchResult } from "./dispatch";
import { reportHealthcheckBestEffort } from "./healthchecks";
import { tickMonitor, type MonitorTick } from "./monitor-object";
import type { DispatchObservation } from "./monitor-policy";
import { resolveScheduledSlot } from "./schedule";
import { SCHEDULED_TASKS } from "./tasks";
import { taskStageHealthchecks, type HealthcheckDefinition, type ScheduledTask, type SchedulerEnv } from "./types";

export { MaintenanceMonitor } from "./monitor-object";

interface ScheduledOptions {
  fetcher?: typeof fetch | undefined;
  tasks?: readonly ScheduledTask[];
  monitor?: (tick: MonitorTick) => Promise<void>;
}

const SCHEDULER_HEALTHCHECK: HealthcheckDefinition = {
  name: "JOJO · maintenance-scheduler", slug: "maintenance-scheduler", schedule: "* * * * *", timeZone: "UTC",
  graceSeconds: 3 * 60, tags: "jojo production maintenance scheduler",
  description: "Cloudflare one-minute scheduler and alert-policy consumer heartbeat.",
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

export async function handleScheduled(controller: ScheduledController, env: SchedulerEnv, options: ScheduledOptions = {}): Promise<void> {
  const tasks = options.tasks ?? SCHEDULED_TASKS;
  const observedAt = new Date(controller.scheduledTime).toISOString();
  const slots = new Map<string, number>();
  const settled = await Promise.allSettled(tasks.map(async (task) => {
    const slot = resolveScheduledSlot(task, controller.scheduledTime);
    if (slot) slots.set(task.id, slot.scheduledAtMs);
    return slot ? dispatchScheduledTask(task, env, { fetcher: options.fetcher, observedAtMs: controller.scheduledTime, slot }) : undefined;
  }));
  const monitor = options.monitor ?? ((tick: MonitorTick) => tickMonitor(env, tick));
  const monitorCount = tasks.reduce((count, task) => count + 1 + taskStageHealthchecks(task).length, 0);
  const bodyBudget = Math.max(1, Math.min(8, Math.floor(48 / Math.max(1, monitorCount))));
  const checks = await Promise.allSettled(tasks.flatMap((task, index) => {
    const dispatch = observation(settled[index]!);
    const expectedAt = slots.get(task.id);
    const timing = expectedAt === undefined ? {} : { expectedAt };
    if (dispatch.kind === "failed") console.error(JSON.stringify({ event: "scheduled_task_failed", taskId: task.id, observedAt, ...dispatch }));
    // /start on retries would reset Healthchecks' grace timer.
    return [
      monitor({ slug: task.id, now: controller.scheduledTime, dispatch, bodyBudget, ...timing }),
      ...taskStageHealthchecks(task).map((check) => monitor({ slug: check.slug, now: controller.scheduledTime, bodyBudget, ...timing })),
    ];
  }));
  const monitorFailures = checks.filter((result) => result.status === "rejected");
  for (const result of monitorFailures) console.error(JSON.stringify({ event: "maintenance_monitor_failed", error: String(result.reason) }));
  await reportHealthcheckBestEffort(SCHEDULER_HEALTHCHECK, env.HEALTHCHECKS_API_KEY, monitorFailures.length ? "log" : "success", {
    fetcher: options.fetcher,
    payload: { stage: "maintenance-scheduler", status: monitorFailures.length ? "degraded" : "completed", observedAt, monitorFailures: monitorFailures.length },
  });
  console.log(JSON.stringify({ event: "maintenance_scheduler_tick", observedAt, cron: controller.cron,
    failedTasks: settled.filter((result) => result.status === "rejected").length,
    monitorFailures: monitorFailures.length,
    results: settled.map((result, index) => result.status === "fulfilled" ? result.value ?? { taskId: tasks[index]?.id, due: false } : { taskId: tasks[index]?.id, error: String(result.reason) }),
  }));
}

export default {
  scheduled(controller, env, context): void { context.waitUntil(handleScheduled(controller, env)); },
} satisfies ExportedHandler<SchedulerEnv>;
