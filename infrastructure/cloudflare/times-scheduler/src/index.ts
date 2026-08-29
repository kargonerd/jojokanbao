import { dispatchTimesCapture, type SchedulerEnv } from "./dispatch";

export default {
  scheduled(controller, env, context): void {
    context.waitUntil(
      dispatchTimesCapture(env, { scheduledTime: controller.scheduledTime }).then((result) => {
        console.log(
          JSON.stringify({
            event: "times_capture_dispatched",
            scheduledTime: new Date(controller.scheduledTime).toISOString(),
            cron: controller.cron,
            ...result,
          }),
        );
      }),
    );
  },
} satisfies ExportedHandler<SchedulerEnv>;
