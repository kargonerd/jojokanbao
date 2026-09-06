import { handleScheduled as runScheduler, type ScheduledOptions } from "../../../../tools/maintenance-scheduler/src/index";
import { tickMonitor } from "./monitor-object";
import { exportMigrationState } from "./migration";
import type { SchedulerEnv } from "./types";
export { MaintenanceMonitor } from "./monitor-object";
export function handleScheduled(controller: ScheduledController, env: SchedulerEnv, options: Partial<ScheduledOptions> = {}): Promise<void> {
  if (env.SCHEDULER_BACKEND === "migration-export") return exportMigrationState(env);
  if (env.SCHEDULER_BACKEND === "disabled") return Promise.resolve();
  return runScheduler(controller, env, { ...options, monitor: options.monitor ?? ((tick) => tickMonitor(env, tick)) });
}
export default {
  scheduled(controller, env, context): void { context.waitUntil(handleScheduled(controller, env)); },
} satisfies ExportedHandler<SchedulerEnv>;
