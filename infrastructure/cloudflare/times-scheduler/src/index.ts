import { dispatchTimesCapture, type SchedulerEnv } from "./dispatch";
import { pingHealthcheckBestEffort } from "./healthchecks";

interface ScheduledOptions {
  fetcher?: typeof fetch | undefined;
}

export async function handleScheduled(
  controller: ScheduledController,
  env: SchedulerEnv,
  options: ScheduledOptions = {},
): Promise<void> {
  const scheduledTime = new Date(controller.scheduledTime).toISOString();

  try {
    const result = await dispatchTimesCapture(env, {
      fetcher: options.fetcher,
      scheduledTime: controller.scheduledTime,
    });
    const reports = [
      pingHealthcheckBestEffort(env.HEALTHCHECKS_TIMES_SCHEDULER_URL, "success", {
        fetcher: options.fetcher,
        payload: { stage: "times-scheduler", scheduledTime, ...result },
      }),
    ];
    if (result.outcome === "dispatched") {
      reports.push(
        pingHealthcheckBestEffort(env.HEALTHCHECKS_TIMES_PIPELINE_URL, "start", {
          fetcher: options.fetcher,
          payload: { stage: "times-pipeline", scheduledTime, ...result },
        }),
      );
    }
    await Promise.all(reports);

    console.log(
      JSON.stringify({
        event: "times_capture_dispatched",
        scheduledTime,
        cron: controller.cron,
        ...result,
      }),
    );
  } catch (error) {
    await pingHealthcheckBestEffort(env.HEALTHCHECKS_TIMES_SCHEDULER_URL, "fail", {
      fetcher: options.fetcher,
      payload: {
        stage: "times-scheduler",
        scheduledTime,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

export default {
  scheduled(controller, env, context): void {
    context.waitUntil(handleScheduled(controller, env));
  },
} satisfies ExportedHandler<SchedulerEnv>;
