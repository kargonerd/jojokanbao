import { TaskMonitor, type MonitorTick } from "../../../../tools/maintenance-scheduler/src/monitor-object";
import type { SchedulerEnv } from "./types";
export { configuredMonitor, type MonitorTick } from "../../../../tools/maintenance-scheduler/src/monitor-object";
// Retain the class name and namespace: existing durable data stays in place.
export class MaintenanceMonitor extends TaskMonitor {
  constructor(private readonly migrationContext: DurableObjectState, env: SchedulerEnv) { super(migrationContext, env); }
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/snapshot") {
      return Response.json({ monitor: await this.migrationContext.storage.get("monitor"),
        queue: await this.migrationContext.storage.get("queue-monitor") });
    }
    return super.fetch(request);
  }
}
export async function tickMonitor(env: SchedulerEnv, tick: MonitorTick): Promise<void> {
  if (!env.MONITORS) throw new Error("MONITORS durable binding is missing");
  const stub = env.MONITORS.get(env.MONITORS.idFromName(tick.slug));
  const response = await stub.fetch("https://monitor.internal/tick", {
    method: "POST", body: JSON.stringify(tick), headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) throw new Error(`Monitor tick failed for ${tick.slug}: HTTP ${response.status}`);
}
