import { dispatchScheduledTask, type DispatchResult } from "./dispatch";
import { pingHealthcheckBestEffort } from "./healthchecks";
import { resolveScheduledSlot } from "./schedule";
import { SCHEDULED_TASKS } from "./tasks";
import {
  taskHealthcheckUrl,
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

function schedulerHealthcheckUrl(env: SchedulerEnv): string | undefined {
  return env.HEALTHCHECKS_SCHEDULER_URL ?? env.HEALTHCHECKS_TIMES_SCHEDULER_URL;
}

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
      reports.push(pingHealthcheckBestEffort(taskHealthcheckUrl(task, env), "fail", {
        fetcher: options.fetcher,
        payload: {
          taskId: task.id,
          stage: "scheduler-dispatch",
          status: "failed",
          failureType: "dispatch-failed",
          observedAt,
          error,
        },
      }));
      return;
    }

    if (!result.value.due || !result.value.dispatch) return;
    dueTasks += 1;
    if (result.value.dispatch.outcome !== "dispatched") return;

    dispatchedTasks += 1;
    reports.push(pingHealthcheckBestEffort(taskHealthcheckUrl(task, env), "start", {
      fetcher: options.fetcher,
      payload: {
        ...result.value.dispatch,
        stage: "scheduler-dispatch",
        status: "dispatched",
        observedAt,
      },
    }));
  });

  reports.push(pingHealthcheckBestEffort(schedulerHealthcheckUrl(env), "success", {
    fetcher: options.fetcher,
    payload: {
      stage: "maintenance-scheduler",
      status: "completed",
      observedAt,
      dueTasks,
      dispatchedTasks,
      failedTasks,
    },
  }));
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
