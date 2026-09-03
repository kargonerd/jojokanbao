import { dispatchScheduledTask, type DispatchResult } from "./dispatch";
import {
  provisionHealthcheckBestEffort,
  reportHealthcheckBestEffort,
} from "./healthchecks";
import { resolveScheduledSlot } from "./schedule";
import { SCHEDULED_TASKS } from "./tasks";
import {
  taskHealthcheck,
  type HealthcheckDefinition,
  type ScheduledTask,
  type SchedulerEnv,
} from "./types";

interface ScheduledOptions {
  fetcher?: typeof fetch | undefined;
  tasks?: readonly ScheduledTask[];
}

interface TaskTickResult {
  taskId: string;
  due: boolean;
  dispatch?: DispatchResult;
}

const SCHEDULER_HEALTHCHECK = {
  name: "JOJO · maintenance-scheduler",
  slug: "maintenance-scheduler",
  schedule: "* * * * *",
  timeZone: "UTC",
  graceSeconds: 3 * 60,
  tags: "jojo production maintenance scheduler",
  description: "Cloudflare one-minute maintenance scheduler heartbeat.",
} satisfies HealthcheckDefinition;

export async function handleScheduled(
  controller: ScheduledController,
  env: SchedulerEnv,
  options: ScheduledOptions = {},
): Promise<void> {
  const observedAt = new Date(controller.scheduledTime).toISOString();
  const tasks = options.tasks ?? SCHEDULED_TASKS;
  const settled = await Promise.allSettled(
    tasks.map(async (task): Promise<TaskTickResult> => {
      const slot = resolveScheduledSlot(task, controller.scheduledTime);
      if (!slot) {
        return { taskId: task.id, due: false };
      }
      const dispatch = await dispatchScheduledTask(task, env, {
        fetcher: options.fetcher,
        observedAtMs: controller.scheduledTime,
        slot,
      });
      return { taskId: task.id, due: true, dispatch };
    }),
  );

  const reports: Array<Promise<void>> = [];
  const reportedTasks = new Set<string>();
  let dueTasks = 0;
  let dispatchedTasks = 0;
  let failedTasks = 0;

  settled.forEach((result, index) => {
    const task = tasks[index];
    if (!task) return;

    if (result.status === "rejected") {
      failedTasks += 1;
      const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.error(JSON.stringify({
        event: "scheduled_task_failed",
        taskId: task.id,
        observedAt,
        failureType: "dispatch-failed",
        error,
      }));
      reportedTasks.add(task.id);
      reports.push(reportHealthcheckBestEffort(
        taskHealthcheck(task),
        env.HEALTHCHECKS_API_KEY,
        "fail",
        {
          fetcher: options.fetcher,
          payload: {
            taskId: task.id,
            stage: "scheduler-dispatch",
            status: "failed",
            failureType: "dispatch-failed",
            observedAt,
            error,
          },
        },
      ));
      return;
    }

    if (!result.value.due || !result.value.dispatch) return;
    dueTasks += 1;
    if (result.value.dispatch.outcome !== "dispatched") return;

    dispatchedTasks += 1;
    reportedTasks.add(task.id);
    reports.push(reportHealthcheckBestEffort(
      taskHealthcheck(task),
      env.HEALTHCHECKS_API_KEY,
      "start",
      {
        fetcher: options.fetcher,
        payload: {
          ...result.value.dispatch,
          stage: "scheduler-dispatch",
          status: "dispatched",
          observedAt,
        },
      },
    ));
  });

  for (const task of tasks) {
    if (!reportedTasks.has(task.id)) {
      reports.push(provisionHealthcheckBestEffort(
        taskHealthcheck(task),
        env.HEALTHCHECKS_API_KEY,
        { fetcher: options.fetcher },
      ));
    }
  }

  reports.push(reportHealthcheckBestEffort(
    SCHEDULER_HEALTHCHECK,
    env.HEALTHCHECKS_API_KEY,
    "success",
    {
      fetcher: options.fetcher,
      payload: {
        stage: "maintenance-scheduler",
        status: "completed",
        observedAt,
        dueTasks,
        dispatchedTasks,
        failedTasks,
      },
    },
  ));
  await Promise.all(reports);

  console.log(JSON.stringify({
    event: "maintenance_scheduler_tick",
    observedAt,
    cron: controller.cron,
    dueTasks,
    dispatchedTasks,
    failedTasks,
    results: settled.map((result, index) => result.status === "fulfilled"
      ? result.value
      : {
          taskId: tasks[index]?.id ?? "unknown",
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }),
  }));
}

export default {
  scheduled(controller, env, context): void {
    context.waitUntil(handleScheduled(controller, env));
  },
} satisfies ExportedHandler<SchedulerEnv>;
